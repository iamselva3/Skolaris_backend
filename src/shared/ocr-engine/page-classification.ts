/*
 * Heuristic page classification for OCR'd exam papers. The goal is to keep
 * non-question pages (instructions, OMR sheets, answer keys) out of the draft
 * extraction path so reviewers aren't asked to approve "Time allowed: 3 hours"
 * as if it were a question.
 *
 * Approach: pure text heuristics over already-OCR'd per-page text. No models,
 * no new dependencies. Two signal types:
 *
 *  - Keyword density (case-insensitive substring counts) for INSTRUCTION /
 *    ANSWER_KEY / OMR markers, weighted by position (first 3 pages bias toward
 *    INSTRUCTION; pages near the end bias toward ANSWER_KEY).
 *  - Word-count + question-marker density: a page with ≥3 Q-style markers
 *    (Q1., 1., (a) options near each Q) and >150 words is almost certainly a
 *    QUESTION page; one with <100 words and instruction keywords is INSTRUCTION.
 *
 * Returns a confidence in [0, 1]. Anything < 0.55 is classified UNKNOWN so the
 * pipeline can decide to treat it as a QUESTION page conservatively (better to
 * extract garbage drafts the reviewer can discard than to silently drop a real
 * question page).
 */

export type OcrPageType = 'INSTRUCTION' | 'QUESTION' | 'ANSWER_KEY' | 'OMR' | 'UNKNOWN';

export interface PageClassification {
  pageNum: number;
  type: OcrPageType;
  confidence: number;
  wordCount: number;
  questionMarkerCount: number;
  /**
   * True when the page is classified UNKNOWN but carries substantial content
   * (the heuristic falls through to "extract conservatively"). Surfaced to the
   * review UI so a teacher can decide whether the page held real questions.
   * False for confidently-classified pages OR for UNKNOWN pages that are blank.
   */
  needsReview?: boolean;
}

const INSTRUCTION_KEYWORDS = [
  'instructions',
  'general instructions',
  'directions',
  'time allowed',
  'duration',
  'total marks',
  'maximum marks',
  'marking scheme',
  'negative marking',
  'attempt all',
  'rough work',
  'do not open',
  'before you begin',
  'candidate must',
  'admit card',
  'roll number',
];

const ANSWER_KEY_KEYWORDS = [
  'answer key',
  'answers key',
  'solutions key',
  'correct answer',
  'official answer',
];

const OMR_KEYWORDS = [
  'omr sheet',
  'omr answer sheet',
  'bubble sheet',
  'fill the circle',
  'darken the circle',
  'use only black ball point pen',
  'do not fold the omr',
];

const QUESTION_MARKER_RE = /^\s*(?:q\.?\s*\d{1,3}|(?:\d{1,3})[.):])/gim;
const OPTION_MARKER_RE = /^\s*\(?([a-d])\)?\s*[.):]/gim;
const ANSWER_GRID_RE = /^\s*\d{1,3}\.?\s*\(?[a-d]\)?\s*$/gim;

const countMatches = (text: string, re: RegExp): number => {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n += 1;
  return n;
};

const containsAny = (lowerText: string, keywords: readonly string[]): number => {
  let hits = 0;
  for (const k of keywords) if (lowerText.includes(k)) hits += 1;
  return hits;
};

/**
 * Classify a single page from its OCR'd text. pageNum + totalPages provide a
 * positional prior (front-of-paper bias toward INSTRUCTION, back-of-paper
 * toward ANSWER_KEY).
 */
export const classifyPage = (
  pageNum: number,
  totalPages: number,
  pageText: string,
): PageClassification => {
  const text = pageText ?? '';
  const lower = text.toLowerCase();
  const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;
  const questionMarkerCount = countMatches(text, QUESTION_MARKER_RE);
  const optionMarkerCount = countMatches(text, OPTION_MARKER_RE);
  const answerGridLines = countMatches(text, ANSWER_GRID_RE);

  const instructionHits = containsAny(lower, INSTRUCTION_KEYWORDS);
  const answerKeyHits = containsAny(lower, ANSWER_KEY_KEYWORDS);
  const omrHits = containsAny(lower, OMR_KEYWORDS);

  const isFrontMatter = pageNum <= Math.min(3, Math.max(1, Math.ceil(totalPages * 0.15)));
  const isBackMatter = pageNum >= Math.max(totalPages - 2, Math.ceil(totalPages * 0.8));

  // ANSWER_KEY — pages that are mostly "N. X" answer rows with answer-key keywords nearby.
  if (
    (answerKeyHits >= 1 && answerGridLines >= 5) ||
    (isBackMatter && answerGridLines >= 15 && questionMarkerCount === 0)
  ) {
    return {
      pageNum,
      type: 'ANSWER_KEY',
      confidence: 0.85,
      wordCount,
      questionMarkerCount,
    };
  }

  // OMR — bubble-sheet markers + low text density.
  if (omrHits >= 1 && wordCount < 250) {
    return {
      pageNum,
      type: 'OMR',
      confidence: 0.85,
      wordCount,
      questionMarkerCount,
    };
  }

  // INSTRUCTION — front-of-paper, instruction keywords, low question density.
  if (instructionHits >= 2 && questionMarkerCount <= 2 && (isFrontMatter || wordCount < 200)) {
    return {
      pageNum,
      type: 'INSTRUCTION',
      confidence: 0.8 + Math.min(0.15, instructionHits * 0.03),
      wordCount,
      questionMarkerCount,
    };
  }
  if (isFrontMatter && wordCount < 120 && questionMarkerCount === 0) {
    return {
      pageNum,
      type: 'INSTRUCTION',
      confidence: 0.65,
      wordCount,
      questionMarkerCount,
    };
  }

  // QUESTION — strong signal when there are several question markers + supporting options.
  if (questionMarkerCount >= 3 || (questionMarkerCount >= 1 && optionMarkerCount >= 4)) {
    const conf = Math.min(0.95, 0.6 + questionMarkerCount * 0.05 + optionMarkerCount * 0.02);
    return {
      pageNum,
      type: 'QUESTION',
      confidence: conf,
      wordCount,
      questionMarkerCount,
    };
  }

  // Default for content-bearing pages with no other strong signal: UNKNOWN at
  // moderate confidence, with needsReview=true. We still extract drafts from
  // these pages (see isExtractableQuestionPage) so a real-but-atypical question
  // page never gets silently dropped — but the review UI is told to flag the
  // page for visibility.
  if (wordCount >= 80) {
    return {
      pageNum,
      type: 'UNKNOWN',
      confidence: 0.5,
      wordCount,
      questionMarkerCount,
      needsReview: true,
    };
  }

  return {
    pageNum,
    type: 'UNKNOWN',
    confidence: 0.3,
    wordCount,
    questionMarkerCount,
    needsReview: false,
  };
};

/** Classify every page in an extracted-text array. Pure; safe to unit test. */
export const classifyAllPages = (pageTexts: string[]): PageClassification[] => {
  const total = pageTexts.length;
  return pageTexts.map((t, i) => classifyPage(i + 1, total, t));
};

/** Pages whose drafts should enter the extraction pipeline. */
export const isExtractableQuestionPage = (c: PageClassification): boolean =>
  c.type === 'QUESTION' || (c.type === 'UNKNOWN' && c.wordCount >= 80);

/**
 * Build a single human-readable summary line for the OCR audit log. Format:
 *   "INSTRUCTION=2 QUESTION=22 ANSWER_KEY=1 OMR=0 UNKNOWN=0 needsReview=1"
 * The `needsReview` count is the number of UNKNOWN-but-content-bearing pages
 * surfaced to the reviewer. This is meant to be eyeballed in logs — the
 * underlying per-page array stays in OcrJob.pageMetadata for richer UI use.
 */
export const summarizeClassifications = (cs: PageClassification[]): string => {
  const tally: Record<OcrPageType, number> = {
    INSTRUCTION: 0,
    QUESTION: 0,
    ANSWER_KEY: 0,
    OMR: 0,
    UNKNOWN: 0,
  };
  let needsReview = 0;
  for (const c of cs) {
    tally[c.type] += 1;
    if (c.needsReview) needsReview += 1;
  }
  return [
    `INSTRUCTION=${tally.INSTRUCTION}`,
    `QUESTION=${tally.QUESTION}`,
    `ANSWER_KEY=${tally.ANSWER_KEY}`,
    `OMR=${tally.OMR}`,
    `UNKNOWN=${tally.UNKNOWN}`,
    `needsReview=${needsReview}`,
  ].join(' ');
};
