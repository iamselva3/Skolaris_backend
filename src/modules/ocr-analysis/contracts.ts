/**
 * OCR ENTERPRISE ARCHITECTURE — Phase 1 framework contracts (SHADOW MODE).
 *
 * This module wraps NOTHING in the live OCR flow and NEVER MODIFIES `src/shared/ocr-engine/*`,
 * the OcrJobRunner, HandleOcrCallbackUseCase, or CompleteUploadUseCase. The Question Completion
 * validator REUSES the engine's EXPORTED, read-only Session-3 Q+O helpers (`isCompleteBlock` /
 * `classifyBlock`) — reuse, not a second Q+O system, and not modification. Detectors EXECUTE,
 * COLLECT findings, EMIT confidence + logs; the framework's auto-fixes apply only to its OWN
 * derived output, never to live persistence. The live OCR flow stays 100% identical.
 *
 * See docs/OCR_ENTERPRISE_ARCHITECTURE.md (frozen) for the design-of-record.
 */

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Read-only mirror of an OCR word box — the framework never mutates engine output. */
export interface ShadowWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Read-only mirror of an emitted OCR draft (question crop) — never mutated. */
export interface ShadowDraft {
  index: number;
  page: number;
  questionNumber: number | null;
  text: string;
  coords?: BBox;
}

/* ───────────────────────────── Page Analyzer features (value-free) ───────────────────────────── */

export interface GutterCandidate {
  /** centre x of the empty vertical run (page px). */
  x: number;
  width: number;
  /** fraction of body rows that are fully empty across the run (1 = perfect river). */
  cleanFraction: number;
}

/** A numeral token lifted from OCR words — RAW evidence only; shape classification is a
 *  detector's job, not the analyzer's. */
export interface NumeralToken {
  text: string;
  /** leading integer if the token starts with digits, else null. */
  value: number | null;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PageFeatures {
  pageIndex: number;
  width: number;
  height: number;
  /** fraction of the body region that is ink (0..1). */
  textDensity: number;
  /** per-x ink fraction over the body (downsampled to `inkProfileBuckets`). */
  inkProfile: number[];
  inkProfileBuckets: number;
  bodyTop: number;
  bodyBottom: number;
  /** candidate whitespace gutters in the central band (evidence for the multi-column detector). */
  gutters: GutterCandidate[];
  /** large low-text regions (figure/table candidates). Phase-1 placeholder: may be empty. */
  figureBboxes: BBox[];
  /** numeral tokens at/near line starts (evidence for content-numeral / duplicate detectors). */
  numerals: NumeralToken[];
  wordCount: number;
}

/* ───────────────────────────── Detector contract ───────────────────────────── */

export type Tier = 'HIGH' | 'MEDIUM' | 'LOW';

/** Global auto/review/no-op boundaries. NEVER per-PDF. */
export const TIER_THRESHOLDS = { high: 0.85, low: 0.5 } as const;

export const tierOf = (confidence: number): Tier =>
  confidence >= TIER_THRESHOLDS.high ? 'HIGH' : confidence >= TIER_THRESHOLDS.low ? 'MEDIUM' : 'LOW';

/** Phase 1: NONE (shadow). Phase 2 activates REMOVE_DRAFT for the Content-Numeral detector only —
 *  the orchestrator applies it ONLY for HIGH-tier findings; MEDIUM → review, LOW → NO-OP. */
export type ProposedCorrection = 'NONE' | 'REMOVE_DRAFT';

export interface Finding {
  detector: string;
  /** detector-specific finding kind, e.g. 'unit-as-marker', 'false-column'. */
  kind: string;
  target: { page: number; bbox?: BBox; draftIndex?: number };
  /** 0..1; mapped to a tier by `tierOf`. */
  confidence: number;
  evidence: Record<string, unknown>;
  /** SHADOW: always 'NONE' in Phase 1 — nothing is applied. */
  proposedCorrection: ProposedCorrection;
}

export interface DetectorContext {
  features: PageFeatures;
  /** read-only OCR output for the page. */
  drafts: ReadonlyArray<ShadowDraft>;
  words: ReadonlyArray<ShadowWord>;
}

/**
 * An INDEPENDENT detector: a pure function over the shared feature bus. It reads only `ctx`,
 * never another detector's output, and EMITS findings — it never mutates anything. Behaviour
 * for the 8 detectors is intentionally NOT implemented in Phase 1 (each returns []).
 */
/** Cross-page context for detectors that must see the whole paper (e.g. duplicate numbering /
 *  section restarts). */
export interface PaperDetectorContext {
  drafts: ReadonlyArray<ShadowDraft>;
  pages: ReadonlyArray<PageFeatures>;
  wordsByPage: ReadonlyArray<ReadonlyArray<ShadowWord>>;
}

export interface Detector {
  readonly name: string;
  /** run order (1..8). */
  readonly order: number;
  /** the geometry/semantics/OCR basis this detector is allowed to use (explainability gate). */
  readonly basis: ReadonlyArray<'geometry' | 'semantics' | 'ocr'>;
  /** page-level pass (default for most detectors). */
  detect(ctx: DetectorContext): Finding[];
  /** OPTIONAL paper-level pass for detectors needing cross-page context. Page-level detectors
   *  leave this undefined. */
  detectPaper?(ctx: PaperDetectorContext): Finding[];
}

/** Duplicate-number classification (Phase 3). Section restarts are NOT failures. */
export type DuplicateClass = 'section-restart' | 'ocr-mislabel' | 'real-fragment';

/* ───────────────────────────── Question Integrity Validator ───────────────────────────── */

export interface IntegrityScore {
  page: number;
  draftIndex: number;
  /** 0..1 confidence the crop is a complete Question+Options unit. */
  score: number;
  /** whether stem + options (+ required figure) are present (Session-3 completion). */
  complete: boolean;
  /** the COMPLETION BOUNDARY — y where stem+options end; null if not derivable. The future
   *  Explanation Block detector reuses this (everything below it is a candidate footer). */
  completeAtY: number | null;
  /** PASS = keep; REVIEW = uncertain (routed to review); CORRECT is reserved (never auto-edits). */
  route: 'PASS' | 'REVIEW' | 'CORRECT';
  evidence: Record<string, unknown>;
}

export interface IntegrityValidator {
  validate(ctx: DetectorContext): IntegrityScore[];
}

/* ───────────────────────────── Orchestrator output (observability) ───────────────────────────── */

export interface AnalysisReport {
  page: number;
  featuresSummary: { width: number; height: number; textDensity: number; gutters: number; numerals: number; drafts: number };
  findings: Finding[];
  integrity: IntegrityScore[];
  /** invariant: Phase 1 applies nothing. */
  applied: 0;
}

/* ───────────────────────────── Paper-level structure (Phase 2) ───────────────────────────── */

/** A maximal run of question numbers before a restart (multi-subject papers restart per section). */
export interface SectionSpan {
  startDraftIndex: number;
  endDraftIndex: number;
  firstNumber: number | null;
  lastNumber: number | null;
  count: number;
}

export interface PaperStructure {
  pageCount: number;
  draftCount: number;
  numeralCount: number;
  /** numbering segments, restart-aware (a restart = a number ≤ the previous one). */
  sections: SectionSpan[];
  /** derived logical question count — section-restart aware, NEVER a hardcoded value. In Phase 2
   *  this is the count AFTER the only active detector (Content Numerals); later detectors refine it. */
  expectedQuestionCount: number;
}

export interface PaperReport {
  structure: PaperStructure;
  ocrDraftCount: number;
  /** draft count after HIGH-tier Content-Numeral auto-fixes are applied (in the framework output). */
  correctedDraftCount: number;
  autoFixed: Finding[]; // HIGH — phantoms removed (content-numeral + duplicate-fragment/mislabel)
  reviewQueue: Finding[]; // MEDIUM — routed to review, NOT removed
  noOpCount: number; // LOW — left untouched
  /** the indices removed by auto-fix (into the original flattened draft list). */
  removedDraftIndices: number[];
  /** per-draft completion boundary from the Question Completion validator (boundary source for the
   *  future Explanation Block detector — Phase 3 PREP only, no trimming applied). */
  completionBoundaries: Array<{ draftIndex: number; complete: boolean; completeAtY: number | null }>;
  /** Phase 4 — count reconciliation decision (final logical count + status). */
  reconciliation: Reconciliation;
  /** Phase 4 — review queue, routed to only ambiguous/low-confidence items (never clean papers). */
  routedReview: ReviewItem[];
  /** Phase 5 — per-question lifecycle records (START→EXPAND→COMPLETE→FINALIZE→EMIT). */
  lifecycle: QuestionLifecycle[];
  /** Phase 5 — number of emitted Question+Options crops. Invariant: == finalLogicalCount. */
  emittedCount: number;
  /** Phase 6 — informational HIGH findings from active detectors that REMOVE nothing (e.g. a
   *  detected multi-column page). Surfaced for observability; never auto-fix, never review. */
  observations: Finding[];
  /** Every finding from every detector with its routing outcome — the basis for per-detector
   *  contributions in the Enterprise Validation report. */
  allFindings: RoutedFinding[];
  /** Corrections APPLIED to the framework's derived crops (not live persistence). */
  corrections: { explanationTrims: number; splitMerges: number; crossPageMerges: number };
  /** Per-surviving-draft correction provenance (merged regions / source pages / trim boundary) —
   *  consumed by the Production Bridge Layer. */
  appliedProvenance: Array<{ draftIndex: number; mergedRegions: BBox[]; sourcePages: number[]; trimmedToY: number | null }>;
}

/* ───────────────────────────── Production Bridge Layer (export-ready objects) ───────────────────────────── */

/** One export-ready logical question. Pure object — no rendering, no storage, no persistence. */
export interface BridgeQuestion {
  questionId: string; // stable, deterministic (not random)
  questionNumber: number | null; // hint only
  sourcePages: number[]; // >1 only for cross-page continuations
  questionOptionsBbox: BBox; // final Question+Options crop (post-correction)
  finalBoundaries: BBox; // the locked emit boundary (== questionOptionsBbox)
  mergedRegions: BBox[]; // constituent regions ([self] when not merged)
  explanationTrimY: number | null; // y the explanation was trimmed at, or null
  reviewStatus: 'ok' | 'review';
  confidence: number; // 0..1
}

export interface BridgeReport {
  questions: BridgeQuestion[];
  totalLogicalQuestions: number;
  totalBridgeObjects: number;
  nToN: boolean;
  duplicateObjects: number;
  orphanObjects: number;
  extraObjects: number;
  missingObjects: number;
  explanationLeakageObjects: number; // crops still containing a solution onset (flagged OR silent)
  silentLeakageObjects: number; // leakage NOT routed to review — MUST be 0 (no silent failures)
  brokenBoundaryObjects: number; // emitted bbox with invalid/degenerate geometry — MUST be 0
  splitMergedObjects: number; // exercised split merges reflected in bridge
  crossPageMergedObjects: number; // exercised cross-page merges reflected in bridge
}

/* ───────────────────────────── Delivery Gate (TASK 2) ───────────────────────────── */

export interface DeliveryDecision {
  /** DELIVER = corrected crops leave the system; REVIEW_ENTIRE_PDF = whole paper routed to review. */
  status: 'DELIVER' | 'REVIEW_ENTIRE_PDF';
  reasons: string[]; // PDF-level gate failures (empty when DELIVER)
  deliveredQuestions: number; // questions delivered as final crops
  reviewQuestions: number; // questions flagged for human review (low-confidence)
  /** Explicit blocker flag — true whenever the PDF is held for review (never silently delivered). */
  reviewRequired: boolean;
}

/** Optional split-fallback signal handed to the Delivery layer (derived from the framework report).
 *  When an unresolved split orphan exists, delivery is BLOCKED (split-question-unresolved). */
export interface DeliverySplitSignal {
  unresolvedSplitOrphans: number;
  questionOptionsCompletePct: number;
}

/* ───────────────────────────── Enterprise Validation (shadow reporting layer) ───────────────────────────── */

export type FindingOutcome = 'auto-fix' | 'review' | 'observe' | 'no-op';

export interface RoutedFinding {
  detector: string;
  kind: string;
  confidence: number;
  outcome: FindingOutcome;
  page: number;
  draftIndex?: number;
}

export interface DetectorContribution {
  detector: string;
  findings: number;
  confidenceMin: number | null;
  confidenceMax: number | null;
  autoFix: number;
  review: number;
  observe: number;
  noOp: number;
}

export interface ValidationReport {
  totalLogicalQuestions: number; // 1
  totalEmittedCrops: number; // 2
  missingQuestions: number; // 3
  duplicateQuestions: number; // 4  (BAD duplicates remaining in the emitted set)
  legitimateDuplicateGroups: number; //    section restarts (informational, NOT a failure)
  orphanCrops: number; // 5
  extraCrops: number; // 6
  questionOptionsCompletePct: number; // 7  (% of emitted crops that are complete)
  explanationLeakageCrops: number; // 8  (emitted crops still containing an explanation block — not trimmed)
  reviewQueueItems: number; // 9
  nToN: boolean; // 10  (emitted == logical)
  detectorContributions: DetectorContribution[]; // 11
  /** Enterprise acceptance breakdown. */
  acceptance: {
    nToN: boolean;
    oneQuestionOneCrop: boolean;
    zeroDuplicateCrops: boolean;
    zeroOrphanCrops: boolean;
    zeroExtraCrops: boolean;
    zeroExplanationLeakage: boolean;
    pass: boolean;
    /** criteria that require APPLYING deferred corrections (trim/merge) — not achievable in shadow. */
    blockedByDeferredApplication: string[];
  };
}

/* ───────────────────────────── Count reconciliation + Review routing (Phase 4) ───────────────────────────── */

export type ReconciliationStatus = 'PASS' | 'RECONCILED' | 'NEEDS_REVIEW';

export interface Reconciliation {
  ocrCount: number;
  correctedCount: number;
  /** N derived from page/marker/region/SECTION structure (section-restart aware, no hardcoding). */
  expectedCount: number;
  /** the answer: never invents questions, never deletes beyond the applied high-confidence fixes. */
  finalLogicalCount: number;
  status: ReconciliationStatus;
  notes: string[];
}

export type ReviewReason = 'ambiguous-duplicate' | 'ambiguous-boundary' | 'low-confidence';

export interface ReviewItem {
  reason: ReviewReason;
  detector: string;
  page?: number;
  draftIndex?: number;
  detail: Record<string, unknown>;
}

/* ───────────────────────────── Question Lifecycle + Boundary Engine (Phase 5) ───────────────────────────── */

export type LifecycleStage = 'START' | 'EXPAND' | 'COMPLETE' | 'FINALIZE' | 'EMIT';

/** The lifecycle record for one logical question. One logical question = one emitted crop. */
export interface QuestionLifecycle {
  draftIndex: number;
  page: number;
  questionNumber: number | null;
  startRegion: BBox | null; // START — where the question begins
  expandedRegion: BBox | null; // EXPAND — region after growth (Phase 5: == startRegion)
  complete: boolean; // COMPLETE — stem + options (+ required figure)
  boundaryY: number | null; // FINALIZE — locked completion boundary (Session-3 boundary)
  emittedCrop: BBox | null; // EMIT — the single Question+Options crop
  emitted: boolean;
  needsReview: boolean; // low confidence → review (still emitted; NO-OP, never dropped)
  stages: LifecycleStage[];
}

/* Extension hooks for FUTURE detectors. Phase 5 registers NONE (pure pass-through). Ownership:
 *   START    ← Multi-column, Handwritten Markers
 *   EXPAND   ← Wide Content, Split Question+Options, Cross-page Continuation
 *   FINALIZE ← Explanation Block
 * A hook receives the current region and returns an adjusted region; it must be conservative
 * (return the region unchanged when unsure — prefer NO-OP). */
export interface StartHook {
  name: string;
  adjustStart(draft: ShadowDraft, region: BBox, ctx: PaperDetectorContext): BBox;
}
export interface ExpandHook {
  name: string;
  adjustExpand(draft: ShadowDraft, region: BBox, ctx: PaperDetectorContext): BBox;
}
export interface FinalizeHook {
  name: string;
  adjustFinalize(draft: ShadowDraft, region: BBox, boundaryY: number | null): BBox;
}
export interface LifecycleHooks {
  start?: StartHook[];
  expand?: ExpandHook[];
  finalize?: FinalizeHook[];
}

/* ───────────── Explanation-block PREPARATION (NOT implemented — Phase 2 leaves a seam) ─────────────
 * Future rule (do not implement yet): a question is COMPLETE at its Session-3 completion boundary
 * (stem + full option block). Anything AFTER the boundary is a candidate footer/explanation/solution
 * block. It is trimmed ONLY at HIGH confidence; otherwise NO-OP. This interface documents the seam;
 * no detector consumes it in Phase 2. */
export interface CompletionBoundary {
  draftIndex: number;
  /** y where stem+options complete (from the existing Session-3 boundary). null = not derivable. */
  completeAtY: number | null;
  /** content below the boundary — a candidate footer/explanation block. */
  candidateFooter: BBox | null;
}
