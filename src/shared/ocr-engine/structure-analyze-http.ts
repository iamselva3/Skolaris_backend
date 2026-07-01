/*
 * Structural Intelligence Engine — Node↔Python (localhost) client.
 *
 * REUSES the EXISTING internal Python sidecar (the Document Cleanup Engine on localhost:8002 — same
 * service as cleanup-http.ts / structure-http.ts). It adds NO new architecture / service / port /
 * deployment — it calls a new `/analyze-document` route on that already-running engine.
 *
 * Python is a STRUCTURAL INTELLIGENCE engine (NOT OCR, NOT AI): TS hands it the per-page OCR tokens it
 * ALREADY produced (words: text + bbox), Python reasons about DOCUMENT STRUCTURE — question ownership,
 * cross-column / cross-page MERGES, sequence + page-role validation — and returns a PROPOSAL. TS
 * VALIDATES the proposal and is the only authority that persists. Python never crops, never splits,
 * never persists. An uncertain ownership routes to review.
 *
 * Hardened exactly like structure-http.ts: AbortController timeout + a tiny circuit breaker. ANY
 * failure / disabled flag / no URL ⇒ null, and the caller DEGRADES to its existing (TS-only) behaviour.
 * A structural-engine problem can never stall or block an OCR job.
 */
export interface StructureAnalyzeSettings {
  /**
   * Single switch for the Python document-intelligence engine. When on, Python's ownership graph is the
   * AUTHORITY: TS's emitted question set must conform to it (N=N=C) or the document routes to review.
   * Default OFF until the engine is complete + validated (golden rule: never deliver incomplete output).
   */
  enabled: boolean;
  serviceUrl: string | null;
  timeoutMs: number;
}

/**
 * ALWAYS ON (final architecture — no manual engine switching). The single OCR flow always sends TS's
 * OCR tokens to Python /analyze-document; `enabled` is purely a function of the sidecar URL being
 * configured (it reuses the cleanup engine URL, localhost:8002). There is no `STRUCTURE_ANALYZE_ENABLED`
 * gate anymore — Python is the sole intelligence authority on every upload.
 */
export const readStructureAnalyzeSettings = (): StructureAnalyzeSettings => {
  const serviceUrl = process.env.STRUCTURE_ANALYZE_URL || process.env.CLEANUP_ENGINE_URL || null;
  return {
    enabled: !!serviceUrl,
    serviceUrl,
    // Python analyze does the FULL intelligence pass over every page + CV badge/seal detection on the
    // page renders, which on a large scanned paper (e.g. AD 2601: 19 pages, ~32MB payload) takes ~40s.
    // The old 30s cap ABORTED the call mid-analyze → analyzeDocumentHttp returned null → the whole
    // Python result was discarded and TS's raw count (149) was kept. 180s gives real headroom so the
    // result is actually received and used. Override with STRUCTURE_ANALYZE_TIMEOUT_MS.
    timeoutMs: Number(process.env.STRUCTURE_ANALYZE_TIMEOUT_MS) || 180_000,
  };
};

export interface StructureBuildSettings {
  /** End-to-end build: Python builds + returns crops, TS stores them. Default OFF until validated. */
  enabled: boolean;
  serviceUrl: string | null;
  timeoutMs: number;
}

export const readStructureBuildSettings = (): StructureBuildSettings => ({
  enabled: /^(1|true|yes|on)$/i.test(process.env.STRUCTURE_BUILD_ENABLED ?? ''),
  serviceUrl: process.env.STRUCTURE_ANALYZE_URL || process.env.CLEANUP_ENGINE_URL || null,
  timeoutMs: Number(process.env.STRUCTURE_BUILD_TIMEOUT_MS) || 180_000,
});

const THRESHOLD = Number(process.env.STRUCTURE_ANALYZE_BREAKER_THRESHOLD) || 3;
const COOLDOWN_MS = Number(process.env.STRUCTURE_ANALYZE_BREAKER_COOLDOWN_MS) || 30_000;
const breaker = { failures: 0, openUntil: 0 };
export const resetStructureAnalyzeBreaker = (): void => {
  breaker.failures = 0;
  breaker.openUntil = 0;
};
const recordFailure = (): void => {
  breaker.failures += 1;
  if (breaker.failures >= THRESHOLD) breaker.openUntil = Date.now() + COOLDOWN_MS;
};

export interface AnalyzeWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  conf?: number;
}
export interface AnalyzePage {
  index: number;
  width: number;
  height: number;
  pageImageKey?: string | null;
  /** Page render (PNG, base64) — same coord space as the words. Required only for /build-document. */
  imageBase64?: string;
  words: AnalyzeWord[];
}
export interface AnalyzeDocInput {
  documentId: string;
  pages: AnalyzePage[];
  /**
   * OCR engine selection (set by the document classifier, NOT a global flag). 'scanned' tells the Python
   * engine to re-OCR the page renders with RapidOCR before analysis (the platform OCR under-read this
   * document). Omitted/'digital' keeps the platform tokens. The ownership/crop/validation engine is
   * identical for both — only the source tokens differ.
   */
  ocrMode?: 'digital' | 'scanned';
}

export interface ProposalElement {
  kind: string;
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  text?: string | null;
}
export interface ProposalQuestion {
  id: string;
  number: number | null;
  startPage: number;
  endPage: number;
  boxes: ProposalElement[];
  optionCount: number;
  merges: string[];
  multiColumn: boolean;
  multiPage: boolean;
  multiBlock: boolean;
  hasDiagram: boolean;
  complete: boolean;
  confidence: number;
  confidencePct: number;
  /**
   * Decision matrix tier — names the validation level TS applies (Python never auto-accepts on its
   * own; TS always validates + persists): TS_LIGHTWEIGHT (>=98) / TS_FULL (95-97) / REVIEW (<95).
   */
  tier: 'TS_LIGHTWEIGHT' | 'TS_FULL' | 'REVIEW';
  needsReview: boolean;
  reviewReasons: string[];
  /**
   * EXPLICIT CROP INSTRUCTIONS — Python OWNS the boundary; TS crops these verbatim (no geometry).
   * One region per page the question touches, in the same pixel space as the words TS sent.
   */
  cropRegions?: Array<{ page: number; x0: number; y0: number; x1: number; y1: number; ownerId: string }>;
  visualRegions?: Array<{ kind: string; page: number; x0: number; y0: number; x1: number; y1: number }>;
  cropValid?: boolean;
  questionType?: string;
  /** The question NUMBER's glyph box [page, x0, y0, x1, y1] — the locked owner anchor. */
  numberBox?: [number, number, number, number, number] | null;
  /** 7-dimension ownership verdict (ownerPass / nextQuestionSafe / cropAllowed / …). */
  ownershipReport?: {
    ownerPass?: boolean;
    nextQuestionSafe?: boolean;
    cropAllowed?: boolean;
    [k: string]: unknown;
  };
  cropAllowed?: boolean;
  /**
   * PRE-DELIVERY GATE (Python intelligence): true only when the question is complete. When an
   * incomplete question's missing options were RECOVERED by the active search, `recoveredRegions`
   * carries the bounded boxes (same owner, before the next confirmed owner) TS may EXTEND its
   * existing crop to include. TS widens/stitches only — it never builds a new crop or moves a
   * boundary Python did not prove.
   */
  deliverable?: boolean;
  deliveryReport?: {
    deliverable?: boolean;
    complete?: boolean;
    optionCount?: number;
    expectedOptions?: number;
    optionsRecovered?: number;
    searchedRegions?: string[];
    recoveredRegions?: Array<{ page: number; x0: number; y0: number; x1: number; y1: number }>;
    reasons?: string[];
  };
}

export interface ProposalIntegrity {
  logicalQuestionCount: number;
  ownedQuestionCount: number;
  completeQuestionCount: number;
  reviewCount: number;
  orphanElementCount: number;
  ownershipViolations: string[];
  nEqualsNEqualsC: boolean;
  /**
   * Two-stage N=N=C. Stage 1 (Python-only, provable now): logical == ownership == complete.
   * Stage 2 (needs crop-delivery wiring): crop == delivered — PENDING_WIRING until wired.
   */
  nnc: {
    stage1: { logicalQuestionCount: number; ownershipCount: number; completeQuestionCount: number; pass: boolean };
    stage2: { cropCount: number | null; deliveredQuestionCount: number | null; status: 'PENDING_WIRING' | 'PASS' | 'STOP' };
    status: 'PASS' | 'STOP';
  };
  status: 'PASS' | 'STOP';
}
export interface ProposalSequence {
  expectedRange: [number, number] | null;
  duplicates: number[];
  questionZero: boolean;
  impossible: Array<{ prev: number; next: number; reason: string }>;
  gaps: number[];
}
export interface DocumentAnalysisProposal {
  documentId: string;
  schemaVersion: number;
  pageClasses: Array<{
    index: number;
    kind: string;
    confidence: number;
    confidencePct: number;
    /** Semantic page roles (answer-key/correction/appendix) are CANDIDATEs only — TS decides. */
    candidate: boolean;
    reason: string;
  }>;
  questions: ProposalQuestion[];
  orphans: ProposalElement[];
  sequence: ProposalSequence;
  confidence: number;
  recommendation: 'ACCEPT' | 'REVIEW';
  integrity: ProposalIntegrity;
  /**
   * Question Count Authority: the LOGICAL question count (ownership-graph questions after marker
   * reconciliation — NOT crops, NOT OCR token count, NOT persisted rows) + anomalies.
   */
  questionCount: {
    logicalQuestionCount: number;
    /** EXPECTED = the contiguous question-number range (max-min+1). Gate: Expected==Logical or review. */
    expectedCount?: number;
    ownershipCount?: number;
    completeQuestionCount: number;
    cropValidCount?: number;
    expectedOptionCount?: number;
    recoveredQuestions?: number[];
    missingQuestions?: number[];
    confidence: number;
    anomalies: Array<{ type: string; values?: number[]; count?: number; removed?: number }>;
    reconciled: { accepted: number; offMargin: number; spurious: number; restarts: number };
  };
  /**
   * Ownership completeness gate (mandatory BEFORE crop build): per-question heatmap + `cropGate`.
   * Crops may be built/persisted ONLY when `cropGate === 'PASS'`.
   */
  ownershipHeatmap: Array<{
    questionId: string;
    number: number | null;
    completeness: number;
    checks: Record<string, 'PASS' | 'FAIL' | 'N/A'>;
    missing: string[];
    detached: string[];
    ownershipConflicts: string[];
    cropAllowed: boolean;
  }>;
  cropGate: 'PASS' | 'REVIEW';
  /**
   * Per-responsibility promotion (frozen authority split): 'PROMOTED' = Python is the PRIMARY
   * intelligence for that responsibility (TS validates per the matrix); 'NOT_PROMOTED' = Python may
   * only SUGGEST a candidate, TS decides. `persistence` is permanently NOT_PROMOTED.
   */
  promotion: Record<string, 'PROMOTED' | 'NOT_PROMOTED'>;
  notes: string[];
  /**
   * Repeated header/footer BAND per page (key = page index as string → [headerBottomY, footerTopY]).
   * The crop renderer clips each crop to (headerBottom, footerTop) so the repeated institute header/
   * footer (e.g. the "SK LEARNINGS" banner) never appears in a question crop. Content-safe.
   */
  chromeBands?: Record<string, [number, number]>;
}

/**
 * POST a document's per-page tokens to the Python /analyze-document route. Returns the structural
 * PROPOSAL, or null on any failure / circuit-open / disabled / no URL — in which case the caller keeps
 * its own (TS) behaviour. The proposal is ADVISORY: TS validates it before persisting anything.
 */
export const analyzeDocumentHttp = async (
  input: AnalyzeDocInput,
  deps: { serviceUrl: string | null; timeoutMs: number },
): Promise<DocumentAnalysisProposal | null> => {
  if (!deps.serviceUrl) return null;
  if (breaker.openUntil > Date.now()) return null; // circuit open — degrade immediately
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await fetch(`${deps.serviceUrl.replace(/\/+$/, '')}/analyze-document`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`structure analyzer HTTP ${res.status}`);
    breaker.failures = 0;
    breaker.openUntil = 0;
    return (await res.json()) as DocumentAnalysisProposal;
  } catch {
    recordFailure();
    return null;
  } finally {
    clearTimeout(timer);
  }
};

export interface BuildCrop {
  questionId: string;
  number: number | null;
  pngBase64: string | null;
  valid: boolean;
  edges: { top: boolean; bottom: boolean; left: boolean; right: boolean };
}
export interface BuildResult extends DocumentAnalysisProposal {
  crops: BuildCrop[];
  build: {
    cropCount: number;
    deliveredQuestionCount: number;
    stage2: { cropCount: number | null; deliveredQuestionCount: number | null; status: string; pass?: boolean };
  };
  /** True ONLY when every gate passes (Stage 1 + cropGate + Stage 2). TS stores crops iff true. */
  deliver: boolean;
}

/**
 * The COMPLETE Python Document Engine result (`POST /process-document`). It IS a BuildResult (OCR ran
 * as the engine's first internal stage) plus the OCR routing audit and the degraded-page count. TS
 * stores this verbatim when `deliver` is true; otherwise the whole upload routes to review.
 */
export interface ProcessDocumentResult extends BuildResult {
  routing: Array<Record<string, unknown>>;
  engineStatus: { paddle: boolean; trocr: boolean };
  /** Pages whose OCR DEGRADED (an engine they needed was not installed → KEEP PIXELS). >0 ⇒ deliver=false. */
  ocrDegradedPages: number;
}

/**
 * POST a stored document's key to the single Python Document Engine. Python fetches it, runs the FULL
 * lifecycle (OCR router → ownership → crops → N=N=C → deliver) and returns the final result. Returns
 * null on any failure / circuit-open / no URL — the caller routes the upload to review (NEVER falls
 * back to TS OCR). TS performs no OCR and never modifies this result.
 */
export const processDocumentHttp = async (
  input: { storageKey: string; documentId: string; mime?: string },
  deps: { serviceUrl: string | null; timeoutMs: number },
): Promise<ProcessDocumentResult | null> => {
  if (!deps.serviceUrl) return null;
  if (breaker.openUntil > Date.now()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await fetch(`${deps.serviceUrl.replace(/\/+$/, '')}/process-document`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`document engine HTTP ${res.status}`);
    breaker.failures = 0;
    breaker.openUntil = 0;
    return (await res.json()) as ProcessDocumentResult;
  } catch {
    recordFailure();
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * POST words + page renders to /build-document. Python builds + repairs + validates the crops and
 * returns them (base64) with a single `deliver` flag. Returns null on any failure / circuit-open /
 * no URL — caller keeps the TS path. TS never modifies the bytes; it only stores them when deliver.
 */
export const buildDocumentHttp = async (
  input: AnalyzeDocInput,
  deps: { serviceUrl: string | null; timeoutMs: number },
): Promise<BuildResult | null> => {
  if (!deps.serviceUrl) return null;
  if (breaker.openUntil > Date.now()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await fetch(`${deps.serviceUrl.replace(/\/+$/, '')}/build-document`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`document builder HTTP ${res.status}`);
    breaker.failures = 0;
    breaker.openUntil = 0;
    return (await res.json()) as BuildResult;
  } catch {
    recordFailure();
    return null;
  } finally {
    clearTimeout(timer);
  }
};
