/**
 * Answer-key import — the SINGLE canonical grammar + parser + validator (no I/O).
 *
 * Every upload format (TXT, paste, CSV, Excel, and OCR'd PDF/JPG/PNG) is reduced
 * to raw text and parsed HERE, so a key parses identically regardless of how it
 * arrived. The browser does NOT interpret answers — it only turns files into
 * text and renders the ParseReport this module produces.
 *
 * Rules enforced here (backend is authoritative; the frontend is supplementary):
 *   - Question numbers must be >= 1. Zero / below-1 are rejected, never stored.
 *   - One grammar covers: "1-A", "1. A", "1) A", "1. (2)", "1 (A)", "Q1 -> B",
 *     "Question 1 : C", "1 => D", numeric ("12-3"), TRUE/FALSE, multi-column and
 *     multi-per-line layouts.
 *   - Validation is REPORTED (missing / duplicate / conflicting / invalid /
 *     zero / out-of-range), never silently dropped.
 *
 * The use-case (import-answer-key.use-case.ts) handles OCR + persistence; this
 * module stays pure so the parsing/mapping rules are exhaustively unit-tested.
 */

import type { SuggestedAnswer } from '../models/ocr-draft.model';

/* ─────────────────────────────────────────── Canonical grammar (one source) */

// Separator chars allowed between a question number and its answer (NOT "(",
// which we handle separately so parenthesised answers like "(A)"/"(2)" work).
// Includes whitespace, hyphen, en/em dash, dot, colon, close-paren, "=", ">",
// and the unicode arrow "→".
const SEP = String.raw`[\s\-–—.:)=>→,]`;

// At least one separator OR an opening paren must sit between number and answer.
// This is what prevents "123" from being misread as 12 → 3.
const GAP = String.raw`(?:${SEP}+\(?|\s*\()`;

// Optional "Q"/"Question" prefix; a leading boundary so we never match inside a
// larger token (e.g. "ABC1-A") and so a digit that sits INSIDE an answer's
// parens ("(1)") is never read as a question number ("(" is excluded); a 1–4
// digit number; the gap; the answer (TRUE/FALSE win before single letters),
// optionally wrapped in parens; and a trailing boundary so prose ("1 because…")
// can't be read as "1 → B".
const PAIR_RE = new RegExp(
  String.raw`(?<![0-9A-Za-z(])(?:Q(?:uestion)?\s*\.?\s*)?(\d{1,4})${GAP}\s*(TRUE|FALSE|[A-H]|[1-8])\s*\)?(?![0-9A-Za-z])`,
  'gi',
);

// Same shape but captures ANY short alnum token as the "answer", used only to
// surface INVALID answers (e.g. "5 Z", "5 9") that the strict PAIR_RE rejects.
const LOOSE_RE = new RegExp(
  String.raw`(?<![0-9A-Za-z(])(?:Q(?:uestion)?\s*\.?\s*)?(\d{1,4})${GAP}\s*([A-Za-z0-9]{1,2})\s*\)?(?![0-9A-Za-z])`,
  'gi',
);

/**
 * Scan a blob LINE BY LINE so a number→answer pair can never span a newline.
 * This is what stops a trailing number on one line (e.g. a "Total Questions: 22"
 * header) from binding to the leading number of the next line, and keeps each
 * row of a multi-column key self-contained.
 */
const eachMatch = (text: string, re: RegExp, cb: (m: RegExpExecArray) => void): void => {
  for (const line of text.split(/\r?\n/)) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) cb(m);
  }
};

/** Lowest valid question number. Numbering starts at 1 — 0 and below are invalid. */
export const MIN_QUESTION_NUMBER = 1;
/** Highest option index the system ever shows (A..H / 1..8). */
export const MAX_OPTION_INDEX = 8;

export interface AnswerToken {
  /** The token exactly as written in the key ("A", "3", "TRUE"). */
  raw: string;
  /** 1-based option position for letter (A→1) / digit (3→3) answers. */
  correctIndex?: number;
  /** Boolean answer for True/False keys (full-word TRUE/FALSE only). */
  correct?: boolean;
}

export interface InvalidEntry {
  questionNumber: number | null;
  raw: string;
  reason: string;
}

export interface ParsedAnswerKey {
  entries: Map<number, AnswerToken>;
  /** Question numbers that appeared more than once with DIFFERENT answers — kept
   *  out of `entries` (ambiguous) and surfaced for the teacher to resolve. */
  conflicts: number[];
  /** Question numbers seen more than once (INCLUDING identical repeats). */
  duplicates: number[];
  /** Rows with a recognisable number but an unparseable answer value. */
  invalid: InvalidEntry[];
  /** Numbers < 1 (e.g. "0-A") — rejected, never stored. */
  rejected: number[];
}

const tokenFor = (rawAnswer: string): AnswerToken => {
  const up = rawAnswer.toUpperCase();
  if (up === 'TRUE') return { raw: rawAnswer, correct: true };
  if (up === 'FALSE') return { raw: rawAnswer, correct: false };
  if (/^[A-H]$/.test(up)) return { raw: rawAnswer, correctIndex: up.charCodeAt(0) - 64 };
  return { raw: rawAnswer, correctIndex: Number(up) }; // 1..8
};

const isValidAnswerToken = (tok: string): boolean =>
  /^(?:TRUE|FALSE|[A-H]|[1-8])$/i.test(tok.trim());

/** Count valid number→answer pairs in a blob using the canonical grammar.
 *  Used by the answer-key OCR page filter to gauge answer-grid density. */
export const countAnswerPairs = (text: string): number => {
  if (!text) return 0;
  let n = 0;
  eachMatch(text, PAIR_RE, () => {
    n += 1;
  });
  return n;
};

const sameAnswer = (a: AnswerToken, b: AnswerToken): boolean =>
  a.correctIndex === b.correctIndex && a.correct === b.correct;

/**
 * Parse free-form answer-key text with the one canonical grammar. Tolerant of
 * multi-column / multi-per-line layouts (scans the whole blob). Numbers < 1 are
 * rejected; conflicting duplicates are dropped from `entries` and reported.
 */
export const parseAnswerKey = (text: string): ParsedAnswerKey => {
  const entries = new Map<number, AnswerToken>();
  const conflicts = new Set<number>();
  const rejected = new Set<number>();
  const counts = new Map<number, number>();
  if (!text) {
    return { entries, conflicts: [], duplicates: [], invalid: [], rejected: [] };
  }

  // Pass 1 — strict: extract valid number→answer pairs (line-scoped).
  eachMatch(text, PAIR_RE, (m) => {
    const num = Number(m[1]);
    if (num < MIN_QUESTION_NUMBER) {
      rejected.add(num);
      return;
    }
    counts.set(num, (counts.get(num) ?? 0) + 1);
    const token = tokenFor(m[2]);
    const existing = entries.get(num);
    if (existing && !sameAnswer(existing, token)) {
      conflicts.add(num);
      entries.delete(num);
    } else if (!conflicts.has(num)) {
      entries.set(num, token);
    }
  });

  // Pass 2 — loose: surface INVALID answers (number present, answer unparseable).
  const invalid: InvalidEntry[] = [];
  const invalidSeen = new Set<string>();
  eachMatch(text, LOOSE_RE, (m) => {
    const num = Number(m[1]);
    const tok = m[2];
    if (num < MIN_QUESTION_NUMBER) {
      rejected.add(num);
      return;
    }
    if (isValidAnswerToken(tok) || entries.has(num) || conflicts.has(num)) return;
    const key = `${num}:${tok}`;
    if (invalidSeen.has(key)) return;
    invalidSeen.add(key);
    invalid.push({ questionNumber: num, raw: tok, reason: 'Invalid answer value' });
  });

  const duplicates = [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([num]) => num)
    .sort((a, b) => a - b);

  return {
    entries,
    conflicts: [...conflicts].sort((a, b) => a - b),
    duplicates,
    invalid,
    rejected: [...rejected].sort((a, b) => a - b),
  };
};

/* ─────────────────────────────────────────── Canonical entry + ParseReport */

export type CanonicalAnswer =
  | { kind: 'option'; index: number; label: string }
  | { kind: 'boolean'; value: boolean };

/** The required canonical shape every format converges to: { questionNumber, answer }. */
export interface AnswerKeyEntry {
  questionNumber: number;
  answer: CanonicalAnswer;
  /** Token as written in the source key. */
  raw: string;
}

export interface ParseReport {
  /** Distinct, validated entries sorted by question number. */
  entries: AnswerKeyEntry[];
  /** Count of `entries`. */
  totalDetected: number;
  /** True when the lowest detected number is exactly 1 (or there are no entries). */
  startsAtOne: boolean;
  /** Numbers < 1 found in the key (e.g. 0). */
  zeroOrNegative: number[];
  /** Gaps in 1..max among detected numbers. */
  missingNumbers: number[];
  /** Numbers that appeared more than once (incl. identical repeats). */
  duplicates: number[];
  /** Numbers that appeared with DIFFERENT answers (dropped as ambiguous). */
  conflicts: number[];
  /** Number+unparseable-answer rows. */
  invalid: InvalidEntry[];
  /** Numbers whose option index exceeded the matched draft's option count.
   *  Empty for a pure-text preview; filled by the use-case after mapping. */
  outOfRange: number[];
  /** Pages read as answer-key pages (PDF/image only; empty for text formats). */
  pagesUsed: number[];
  /** Pages ignored as solutions/explanations/empty (PDF only), with the reason. */
  pagesIgnored: Array<{ page: number; reason: string }>;
}

const indexToLabel = (index: number): string =>
  index >= 1 && index <= 26 ? String.fromCharCode(64 + index) : String(index);

const toCanonicalAnswer = (tok: AnswerToken): CanonicalAnswer =>
  tok.correct !== undefined
    ? { kind: 'boolean', value: tok.correct }
    : { kind: 'option', index: tok.correctIndex as number, label: indexToLabel(tok.correctIndex as number) };

/**
 * Build the full, UI-facing validation report from raw key text. `outOfRange`
 * and the page fields are filled by the caller (they need draft/OCR context).
 */
export const buildParseReport = (
  text: string,
  pages?: { used: number[]; ignored: Array<{ page: number; reason: string }> },
): ParseReport => {
  const parsed = parseAnswerKey(text);
  const entries: AnswerKeyEntry[] = [...parsed.entries.entries()]
    .sort(([a], [b]) => a - b)
    .map(([questionNumber, tok]) => ({
      questionNumber,
      answer: toCanonicalAnswer(tok),
      raw: tok.raw,
    }));

  const missingNumbers: number[] = [];
  if (entries.length > 0) {
    const present = new Set(entries.map((e) => e.questionNumber));
    const max = entries[entries.length - 1].questionNumber;
    for (let n = MIN_QUESTION_NUMBER; n <= max; n += 1) if (!present.has(n)) missingNumbers.push(n);
  }

  return {
    entries,
    totalDetected: entries.length,
    startsAtOne: entries.length === 0 || entries[0].questionNumber === MIN_QUESTION_NUMBER,
    zeroOrNegative: parsed.rejected,
    missingNumbers,
    duplicates: parsed.duplicates,
    conflicts: parsed.conflicts,
    invalid: parsed.invalid,
    outOfRange: [],
    pagesUsed: pages?.used ?? [],
    pagesIgnored: pages?.ignored ?? [],
  };
};

/* ───────────────────────────────────────────────────────────── Mapping */

// Leading question number on a draft's OCR text: "151. …", "Q.151 …", "Question 1 …".
const DRAFT_NUM_RE = /^\s*(?:Q(?:uestion)?\.?\s*)?(\d{1,3})\s*[.)\s]/i;

/** The question number a draft represents, parsed from its leading OCR token,
 *  or null when the text has no recognizable leading number. */
export const detectDraftNumber = (text: string): number | null => {
  const m = DRAFT_NUM_RE.exec(text ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  return n >= MIN_QUESTION_NUMBER ? n : null;
};

export interface DraftRef {
  id: string;
  text: string;
  /** AUTHORITATIVE question number. This — not the OCR text or any index — is the
   *  identity used for mapping, so reordered/inserted drafts map correctly. Only
   *  when it's null do we fall back to parsing the number from `text`. */
  questionNumber?: number | null;
  /** Detected answer-SLOT count (2..6). UNRELIABLE — the question-OCR slot
   *  detector frequently under-counts (e.g. a 4-option MCQ detected as 2). Use it
   *  only together with `optionsLength` for the effective bound. */
  optionCount?: number | null;
  /** Number of actual labelled options on the draft (A,B,C,D → 4). Reliable; the
   *  effective option bound is max(optionCount, optionsLength). */
  optionsLength?: number | null;
}

export interface AnswerAssignment {
  draftId: string;
  questionNumber: number;
  suggestedAnswer: SuggestedAnswer;
}

export interface AssignmentReport {
  assignments: AnswerAssignment[];
  /** Draft ids with no leading number, or a number absent from the key. */
  unmatchedDraftIds: string[];
  /** Key numbers that matched no draft. */
  unmatchedKeyNumbers: number[];
  /** Key numbers whose index answer exceeds the draft's optionCount. */
  outOfRangeNumbers: number[];
}

/**
 * Map parsed key entries onto drafts by detected question number. An index
 * answer beyond a draft's optionCount is rejected (reported, not assigned) — a
 * sign of a mis-OCR'd key or a wrong-paper key, which the teacher should see.
 */
export const assignAnswersToDrafts = (
  drafts: DraftRef[],
  key: ParsedAnswerKey,
): AssignmentReport => {
  const assignments: AnswerAssignment[] = [];
  const unmatchedDraftIds: string[] = [];
  const outOfRangeNumbers: number[] = [];
  const usedKeyNumbers = new Set<number>();

  for (const d of drafts) {
    // Identity = the persisted question number; fall back to the OCR text only
    // when it's absent (legacy drafts processed before questionNumber existed).
    const num = d.questionNumber ?? detectDraftNumber(d.text);
    const token = num !== null ? key.entries.get(num) : undefined;
    if (num === null || !token) {
      unmatchedDraftIds.push(d.id);
      continue;
    }
    // Effective option bound: trust the actual labelled options over the
    // frequently-under-counted detected slot count. Only when BOTH are absent do
    // we skip bounding entirely. A truly out-of-range answer (e.g. option 5 on a
    // 4-option question — a wrong-paper key) is still rejected and reported.
    const bound = Math.max(d.optionCount ?? 0, d.optionsLength ?? 0);
    if (token.correctIndex !== undefined && bound > 0 && token.correctIndex > bound) {
      outOfRangeNumbers.push(num);
      unmatchedDraftIds.push(d.id);
      continue;
    }
    usedKeyNumbers.add(num);
    assignments.push({
      draftId: d.id,
      questionNumber: num,
      suggestedAnswer: { source: 'answer-key', ...token },
    });
  }

  const unmatchedKeyNumbers = [...key.entries.keys()]
    .filter((n) => !usedKeyNumbers.has(n))
    .sort((a, b) => a - b);

  return {
    assignments,
    unmatchedDraftIds,
    unmatchedKeyNumbers,
    outOfRangeNumbers: [...new Set(outOfRangeNumbers)].sort((a, b) => a - b),
  };
};
