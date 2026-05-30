/*
 * DI-free OCR routing/detection (Phase 1 of the additive handwriting fallback).
 *
 * Pure functions only — no NestJS, no transport, no side effects. Shared by BOTH
 * consumers (src/shared/workers/ocr.processor.ts and scripts/ocr-worker.ts) via
 * resolve-drafts.ts so the routing decision can never diverge between
 * WORKER_MODE=api|worker|both.
 *
 * The whole layer is gated by HANDWRITING_OCR_ENABLED (default false). When the
 * flag is OFF, resolve-drafts never calls any of this and behaviour is
 * byte-identical to today.
 *
 * Stage 1 (preRoute): cheap pre-analysis from mime + path hints. NOTE: the PDF
 * embedded-text-layer probe (the MACHINE_TEXT short-circuit) is intentionally
 * DEFERRED to a later phase; until then PDFs are INCONCLUSIVE and fall through
 * to the Stage-2 confidence/quality score, which already keeps clean machine
 * PDFs on the Node path because they OCR at high confidence.
 *
 * Stage 2 (computeSignal + decide): scores handwriting-likelihood from the
 * Tesseract result the engine already produced (overall confidence, per-word
 * confidence distribution, chars/page, alpha-noise, near-empty sentinel).
 *
 * Thresholds are reasoned defaults, NOT empirically tuned — every value is
 * env-overridable so production can calibrate without a code change.
 */

export type PreRouteVerdict = 'MACHINE_TEXT' | 'SCAN_LIKELY' | 'INCONCLUSIVE';

export interface PreRouteResult {
  verdict: PreRouteVerdict;
  /** true ONLY when verdict === 'MACHINE_TEXT' — forces the Node path. */
  forceNode: boolean;
  isAnswerSheetHint: boolean;
  /** Avg embedded-text-layer chars/page from the PDF probe (0 for images / probe skip). */
  embeddedCharsPerPage: number;
}

export interface WordStats {
  wordCount: number;
  medianWordConfidence: number; // 0..100 (tesseract scale)
  lowWordRatio: number; // 0..1
}

export interface RoutingSignal {
  mime: string;
  pre: PreRouteResult;
  overallConfidence: number; // 0..1
  charsPerPage: number;
  alphaNoiseRatio: number; // 0..1
  nonDictTokenRatio: number; // 0..1
  nearEmpty: boolean;
  words: WordStats;
}

export interface RoutingDecision {
  /** true => hand the job off to the Python service; Node suppresses its callback. */
  route: boolean;
  score: number; // 0..1 handwriting-likelihood
  reason: string;
}

export interface RoutingConfig {
  confidenceThreshold: number; // overallConfidence below this is a route signal
  lowWordConfidence: number; // a "word" is low-confidence below this (0..100)
  lowWordRatio: number; // route signal when low-confidence words exceed this share
  medianWordConfidence: number; // route signal when median word confidence below this
  charsPerPage: number; // route signal when chars/page below this
  emptyCharsPerPage: number; // nearEmpty when chars/page below this
  alphaNoiseRatio: number; // route signal when garbage-char ratio above this
  nonDictTokenRatio: number; // route signal when non-dictionary token ratio above this
  minWordsForStats: number; // below this, trust confidence only (distribution unreliable)
  scoreThreshold: number; // route when weighted score >= this
  weights: [number, number, number, number, number, number];
  answerSheetBias: number;
  scanLikelyBias: number;
  answerSheetHints: string[];
  preHardRouteOnHint: boolean;
  // Stage-1 PDF embedded-text-layer probe (machine-PDF short-circuit).
  preProbePages: number; // how many leading pages to probe
  preTextLayerCharsPerPage: number; // >= this avg ⇒ MACHINE_TEXT (force Node)
  preTextLayerFloor: number; // < this avg ⇒ SCAN_LIKELY
}

export const defaultRoutingConfig = (): RoutingConfig => ({
  confidenceThreshold: 0.7,
  lowWordConfidence: 60,
  lowWordRatio: 0.35,
  medianWordConfidence: 65,
  charsPerPage: 80,
  emptyCharsPerPage: 15,
  alphaNoiseRatio: 0.25,
  nonDictTokenRatio: 0.55,
  minWordsForStats: 8,
  scoreThreshold: 0.5,
  weights: [0.3, 0.2, 0.15, 0.15, 0.1, 0.1],
  answerSheetBias: 0.1,
  scanLikelyBias: 0.1,
  answerSheetHints: ['answer-sheet', 'answersheet', '/answers/', 'handwritten', '/scripts/', '/submissions/'],
  preHardRouteOnHint: false,
  preProbePages: 3,
  preTextLayerCharsPerPage: 100,
  preTextLayerFloor: 10,
});

const num = (env: NodeJS.ProcessEnv, key: string, fallback: number): number => {
  const v = Number(env[key]);
  return Number.isFinite(v) ? v : fallback;
};

type Weights = [number, number, number, number, number, number];
const parseWeights = (raw: string | undefined, fallback: Weights): Weights => {
  if (!raw) return fallback;
  const p = raw.split(',').map((s) => Number(s.trim()));
  if (p.length === 6 && p.every((n) => Number.isFinite(n))) {
    return [p[0], p[1], p[2], p[3], p[4], p[5]];
  }
  return fallback;
};

export const routingConfigFromEnv = (env: NodeJS.ProcessEnv): RoutingConfig => {
  const d = defaultRoutingConfig();
  const hints = env.OCR_PRE_ANSWERSHEET_HINTS;
  return {
    confidenceThreshold: num(env, 'OCR_ROUTE_CONFIDENCE_THRESHOLD', d.confidenceThreshold),
    lowWordConfidence: num(env, 'OCR_ROUTE_LOWWORD_CONFIDENCE', d.lowWordConfidence),
    lowWordRatio: num(env, 'OCR_ROUTE_LOWWORD_RATIO', d.lowWordRatio),
    medianWordConfidence: num(env, 'OCR_ROUTE_MEDIAN_WORD_CONFIDENCE', d.medianWordConfidence),
    charsPerPage: num(env, 'OCR_ROUTE_CHARS_PER_PAGE', d.charsPerPage),
    emptyCharsPerPage: num(env, 'OCR_ROUTE_EMPTY_CHARS_PER_PAGE', d.emptyCharsPerPage),
    alphaNoiseRatio: num(env, 'OCR_ROUTE_ALPHA_NOISE_RATIO', d.alphaNoiseRatio),
    nonDictTokenRatio: num(env, 'OCR_ROUTE_NONDICT_TOKEN_RATIO', d.nonDictTokenRatio),
    minWordsForStats: num(env, 'OCR_ROUTE_MIN_WORDS_FOR_STATS', d.minWordsForStats),
    scoreThreshold: num(env, 'OCR_ROUTE_SCORE_THRESHOLD', d.scoreThreshold),
    weights: parseWeights(env.OCR_ROUTE_WEIGHTS, d.weights),
    answerSheetBias: num(env, 'OCR_ROUTE_ANSWERSHEET_BIAS', d.answerSheetBias),
    scanLikelyBias: num(env, 'OCR_ROUTE_SCANLIKELY_BIAS', d.scanLikelyBias),
    answerSheetHints: hints ? hints.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : d.answerSheetHints,
    preHardRouteOnHint: env.OCR_PRE_HARD_ROUTE_ON_HINT === 'true',
    preProbePages: num(env, 'OCR_PRE_PROBE_PAGES', d.preProbePages),
    preTextLayerCharsPerPage: num(env, 'OCR_PRE_TEXTLAYER_CHARS_PER_PAGE', d.preTextLayerCharsPerPage),
    preTextLayerFloor: num(env, 'OCR_PRE_TEXTLAYER_FLOOR', d.preTextLayerFloor),
  };
};

export const wordStatsFromConfidences = (confidences: number[], lowWordConfidence: number): WordStats => {
  const wordCount = confidences.length;
  if (wordCount === 0) {
    return { wordCount: 0, medianWordConfidence: 0, lowWordRatio: 0 };
  }
  const sorted = [...confidences].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const low = confidences.filter((c) => c < lowWordConfidence).length;
  return { wordCount, medianWordConfidence: median, lowWordRatio: low / wordCount };
};

const alphaNoise = (text: string): number => {
  const stripped = text.replace(/\s+/g, '');
  if (stripped.length === 0) return 0;
  // "garbage" = not letters, digits, or common sentence punctuation.
  const garbage = stripped.replace(/[a-zA-Z0-9.,;:?!'"()\-/%$=+]/g, '').length;
  return garbage / stripped.length;
};

const nonDictRatio = (text: string): number => {
  const tokens = text.toLowerCase().match(/[a-z]{2,}/g) ?? [];
  if (tokens.length === 0) return 0;
  // Heuristic only (no dictionary): a token with no vowel, or with 3+ identical
  // consecutive letters, reads as OCR garble. Low weight by default.
  const bad = tokens.filter((t) => !/[aeiou]/.test(t) || /(.)\1\1/.test(t)).length;
  return bad / tokens.length;
};

/* ── Stage-1 PDF embedded-text-layer probe (machine-PDF short-circuit) ──
 * pdfjs-dist is ESM-only; load it via a Function-indirection dynamic import so
 * TypeScript's commonjs target does NOT downlevel it to require(). Fully
 * defensive: any probe failure returns 0 chars ⇒ INCONCLUSIVE ⇒ Stage 2.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;

interface PdfTextItem {
  str?: string;
}
interface PdfPageLike {
  getTextContent: () => Promise<{ items: PdfTextItem[] }>;
}
interface PdfDocLike {
  numPages: number;
  getPage: (n: number) => Promise<PdfPageLike>;
  destroy?: () => Promise<void>;
}
interface PdfjsLike {
  getDocument: (src: Record<string, unknown>) => { promise: Promise<PdfDocLike> };
}

let pdfjs: PdfjsLike | null = null;
const loadPdfjs = async (): Promise<PdfjsLike> => {
  if (!pdfjs) {
    pdfjs = (await esmImport('pdfjs-dist/legacy/build/pdf.mjs')) as PdfjsLike;
  }
  return pdfjs;
};

const probePdfTextLayer = async (bytes: Buffer, cfg: RoutingConfig): Promise<number> => {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
  }).promise;
  try {
    const pages = Math.min(doc.numPages, Math.max(1, cfg.preProbePages));
    let chars = 0;
    for (let i = 1; i <= pages; i += 1) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      for (const item of tc.items) chars += (item.str ?? '').length;
    }
    return chars / pages;
  } finally {
    if (doc.destroy) await doc.destroy().catch(() => undefined);
  }
};

/**
 * Stage 1 — cheap pre-analysis: path hints + (for PDFs) an embedded-text-layer
 * probe. A machine-generated PDF (substantial selectable text) ⇒ MACHINE_TEXT ⇒
 * forceNode (never route to handwriting). A text-poor PDF ⇒ SCAN_LIKELY (a
 * routing bias, still confirmed by Stage 2 to protect clean printed scans).
 */
export const preRoute = async (
  input: { storageKey: string; mime: string; bytes?: Buffer },
  cfg: RoutingConfig,
): Promise<PreRouteResult> => {
  const key = input.storageKey.toLowerCase();
  const isAnswerSheetHint = cfg.answerSheetHints.some((h) => key.includes(h));
  const base: PreRouteResult = {
    verdict: 'INCONCLUSIVE',
    forceNode: false,
    isAnswerSheetHint,
    embeddedCharsPerPage: 0,
  };

  if (input.mime !== 'application/pdf' || !input.bytes) return base;

  try {
    const perPage = await probePdfTextLayer(input.bytes, cfg);
    if (perPage >= cfg.preTextLayerCharsPerPage) {
      return { ...base, verdict: 'MACHINE_TEXT', forceNode: true, embeddedCharsPerPage: perPage };
    }
    if (perPage < cfg.preTextLayerFloor) {
      return { ...base, verdict: 'SCAN_LIKELY', embeddedCharsPerPage: perPage };
    }
    return { ...base, embeddedCharsPerPage: perPage };
  } catch {
    // Probe failure must NEVER break routing — fall through to Stage 2.
    return base;
  }
};

export interface SignalInput {
  mime: string;
  overallConfidence: number; // 0..1
  text: string;
  pageCount: number;
  wordConfidences: number[]; // raw per-word confidences (0..100), empty if not collected
  sentinel: boolean; // the "(OCR produced no extractable text)" fallback fired
}

export const computeSignal = (input: SignalInput, pre: PreRouteResult, cfg: RoutingConfig): RoutingSignal => {
  const charsPerPage = input.text.length / Math.max(1, input.pageCount);
  return {
    mime: input.mime,
    pre,
    overallConfidence: input.overallConfidence,
    charsPerPage,
    alphaNoiseRatio: alphaNoise(input.text),
    nonDictTokenRatio: nonDictRatio(input.text),
    nearEmpty: input.sentinel || charsPerPage < cfg.emptyCharsPerPage,
    words: wordStatsFromConfidences(input.wordConfidences, cfg.lowWordConfidence),
  };
};

export const decideRoute = (s: RoutingSignal, cfg: RoutingConfig): RoutingDecision => {
  // Hard overrides first.
  if (s.pre.forceNode) return { route: false, score: 0, reason: 'machine_text_force_node' };
  if (s.nearEmpty) return { route: true, score: 1, reason: 'near_empty' };
  if (cfg.preHardRouteOnHint && s.pre.isAnswerSheetHint) {
    return { route: true, score: 1, reason: 'answer_sheet_hint' };
  }

  // Tiny samples: word-distribution stats are unreliable — trust confidence only.
  if (s.words.wordCount < cfg.minWordsForStats) {
    const route = s.overallConfidence < cfg.confidenceThreshold;
    return {
      route,
      score: route ? 1 : 0,
      reason: route ? 'low_confidence_small_sample' : 'high_confidence_small_sample',
    };
  }

  const [w1, w2, w3, w4, w5, w6] = cfg.weights;
  let score =
    (s.overallConfidence < cfg.confidenceThreshold ? w1 : 0) +
    (s.words.lowWordRatio > cfg.lowWordRatio ? w2 : 0) +
    (s.words.medianWordConfidence < cfg.medianWordConfidence ? w3 : 0) +
    (s.charsPerPage < cfg.charsPerPage ? w4 : 0) +
    (s.alphaNoiseRatio > cfg.alphaNoiseRatio ? w5 : 0) +
    (s.nonDictTokenRatio > cfg.nonDictTokenRatio ? w6 : 0);
  if (s.pre.isAnswerSheetHint) score += cfg.answerSheetBias;
  if (s.pre.verdict === 'SCAN_LIKELY') score += cfg.scanLikelyBias;

  const route = score >= cfg.scoreThreshold;
  return { route, score: Math.min(1, Math.round(score * 100) / 100), reason: route ? 'score_threshold' : 'below_threshold' };
};
