import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AnalysisReport,
  Detector,
  DetectorContext,
  Finding,
  PageFeatures,
  PaperDetectorContext,
  PaperReport,
  ShadowDraft,
  ShadowWord,
  tierOf,
} from './contracts';
import { DETECTORS } from './detectors';
import { PageAnalyzer } from './page-analyzer';
import { PaperAnalyzer } from './paper-analyzer';
import { CountReconciler } from './count-reconciler';
import { ReviewQueueRouter } from './review-queue';
import { QuestionLifecycleEngine } from './lifecycle';
import { MultiColumnStartHook } from './multi-column';
import { WideContentExpandHook } from './wide-content';
import { SplitQuestionExpandHook } from './split-question';
import { CrossPageExpandHook } from './cross-page';
import { HandwrittenStartHook } from './handwritten';
import { ExplanationFinalizeHook } from './explanation';
import { CorrectionApplier } from './correction-applier';
import { ShadowIntegrityValidator } from './integrity-validator';

/** One page's OCR output for the paper-level pass. */
export interface PageInput {
  pageImage: Buffer;
  pageIndex: number;
  drafts: ShadowDraft[];
  words: ShadowWord[];
}

/**
 * SHADOW ORCHESTRATOR. Runs Page Analyzer → all detectors (shadow) → integrity validator, and
 * EMITS LOGS + a report. It is the only entrypoint of the framework and is NOT called by the live
 * OCR flow — so OCR output is 100% identical. INVARIANT: it applies nothing (report.applied === 0).
 *
 * Detectors run in declared order; their findings are collected and logged with confidence +
 * tier, but no correction is applied (Phase 1). Conflict resolution / safety ordering belong to a
 * later orchestration phase and are deliberately absent here.
 */
@Injectable()
export class OcrShadowAnalyzer {
  private readonly logger = new Logger('ocr-shadow');

  constructor(
    private readonly analyzer: PageAnalyzer,
    @Inject(DETECTORS) private readonly detectors: Detector[],
    private readonly validator: ShadowIntegrityValidator,
    private readonly paper: PaperAnalyzer,
    private readonly reconciler: CountReconciler,
    private readonly review: ReviewQueueRouter,
    private readonly lifecycle: QuestionLifecycleEngine,
    private readonly multiColumnStart: MultiColumnStartHook,
    private readonly wideContentExpand: WideContentExpandHook,
    private readonly splitQuestionExpand: SplitQuestionExpandHook,
    private readonly crossPageExpand: CrossPageExpandHook,
    private readonly handwrittenStart: HandwrittenStartHook,
    private readonly explanationFinalize: ExplanationFinalizeHook,
    private readonly applier: CorrectionApplier,
  ) {}

  /** Names of detectors whose findings are ACTED ON (Phase 11: ALL 8 detectors now active). Each
   *  applies only its own safe action (auto-fix / observation / review / NO-OP). */
  private readonly active = new Set([
    'content-numerals', 'duplicate-numbering', 'multi-column', 'wide-content',
    'split-question-options', 'cross-page-continuation', 'handwritten-markers', 'explanation-blocks',
  ]);

  /**
   * PHASE 2 paper-level pass. Analyzes the whole paper, runs all detectors per page (only the
   * ACTIVE one is applied), then by tier: HIGH content-numeral phantoms are auto-fixed (removed
   * from the framework's corrected output), MEDIUM → review queue, LOW → NO-OP. Finally derives the
   * paper structure + expected logical question count from the CORRECTED draft set.
   *
   * This produces the framework's corrected output; it does NOT mutate the live OCR persistence
   * (no hook into HandleOcrCallback / OcrJobRunner — those stay frozen).
   */
  async analyzePaper(pages: PageInput[]): Promise<PaperReport> {
    const allDrafts: ShadowDraft[] = [];
    const pageFeatures: PageFeatures[] = [];
    const wordsByPage: ShadowWord[][] = [];
    let numeralCount = 0;
    const autoFixed: Finding[] = [];
    const reviewQueue: Finding[] = [];
    const observations: Finding[] = [];
    const allFindings: PaperReport['allFindings'] = [];
    let noOpCount = 0;
    const completionBoundaries: PaperReport['completionBoundaries'] = [];

    const route = (f: Finding, acted: boolean): void => {
      const tier = tierOf(f.confidence);
      let outcome: 'auto-fix' | 'review' | 'observe' | 'no-op';
      if (acted && tier === 'HIGH' && f.proposedCorrection === 'REMOVE_DRAFT') { autoFixed.push(f); outcome = 'auto-fix'; }
      else if (acted && tier === 'MEDIUM') { reviewQueue.push(f); outcome = 'review'; }
      else if (acted && tier === 'HIGH') { observations.push(f); outcome = 'observe'; } // informational HIGH
      else { noOpCount += 1; outcome = 'no-op'; } // LOW, or any finding from a SHADOW detector
      allFindings.push({ detector: f.detector, kind: f.kind, confidence: f.confidence, outcome, page: f.target.page, draftIndex: f.target.draftIndex });
      this.logger.debug(`${f.detector} ${f.kind} conf=${f.confidence.toFixed(2)} tier=${tier} ${outcome.toUpperCase()}`);
    };

    // ── per-page: Page Analyzer → page-level detectors → Question Completion validator ──
    for (const pg of pages) {
      const features = await this.analyzer.analyze(pg.pageImage, pg.pageIndex, pg.words);
      pageFeatures.push(features);
      wordsByPage.push(pg.words);
      numeralCount += features.numerals.length;
      const ctx: DetectorContext = { features, drafts: pg.drafts, words: pg.words };
      for (const det of this.detectors) for (const f of det.detect(ctx)) route(f, this.active.has(det.name));

      // Question Completion validator (reuses Session-3 Q+O completion). Establishes boundaries +
      // routes only option-only orphans to REVIEW.
      for (const s of this.validator.validate(ctx)) {
        completionBoundaries.push({ draftIndex: s.draftIndex, complete: s.complete, completeAtY: s.completeAtY });
        if (s.route === 'REVIEW') {
          reviewQueue.push({ detector: 'question-completion', kind: 'option-only-incomplete', target: { page: s.page, draftIndex: s.draftIndex }, confidence: 0.7, evidence: s.evidence, proposedCorrection: 'NONE' });
        }
      }
      allDrafts.push(...pg.drafts);
    }

    // ── paper-level: Duplicate Numbering (cross-page) ──
    const pctx: PaperDetectorContext = { drafts: allDrafts, pages: pageFeatures, wordsByPage };
    for (const det of this.detectors) {
      if (!det.detectPaper) continue;
      for (const f of det.detectPaper(pctx)) route(f, this.active.has(det.name));
    }

    const removedDraftIndices = autoFixed.map((f) => f.target.draftIndex).filter((i): i is number => typeof i === 'number');
    const removed = new Set(removedDraftIndices);
    const corrected = allDrafts.filter((d) => !removed.has(d.index));

    // ── APPLY detected corrections to the derived crops (Enterprise mode) ──
    // Explanation trim (FINALIZE) + Split merge (EXPAND) + Cross-page merge (EXPAND). Engine/persistence
    // untouched; this corrects the framework's emitted crops. References exercise only explanation trim.
    const explanationFindings = observations.filter((f) => f.detector === 'explanation-blocks');
    // TEMPORARY LAYOUT FLATTENING: feed the applier every structurally-PROVABLE split candidate (the
    // detector's `provable` = incomplete stem + option-only orphan + marker-free path). The detector
    // does not auto-merge (a markerFreePath alone false-merged across columns on RE NEET); the APPLIER
    // now applies the STOP rule (no other marked question inside the stem→orphan span) before flattening,
    // so a tight column/row split flattens to one crop while a sprawling cross-question span is refused.
    const splitAssociable = reviewQueue.filter(
      (f) => f.detector === 'split-question-options' &&
        (f.kind === 'split-orphan-associable' || (f.evidence as { provable?: boolean }).provable === true),
    );
    const crossPageFindings = reviewQueue.filter((f) => f.detector === 'cross-page-continuation');
    const applied = this.applier.apply(corrected, explanationFindings, splitAssociable, crossPageFindings);
    const final = applied.drafts;
    const corrections = { explanationTrims: applied.explanationTrims, splitMerges: applied.splitMerges, crossPageMerges: applied.crossPageMerges };
    const appliedProvenance = [...applied.provenance.values()];
    // applied split/cross-page candidates are resolved ⇒ leave the review queue
    const appliedFindings = new Set<Finding>([...splitAssociable, ...crossPageFindings]);
    const reviewRemaining = reviewQueue.filter((f) => !appliedFindings.has(f));

    const structure = this.paper.analyze(final, pages.length, numeralCount);
    // STEP 5 — declined explanation trims (anti-aggressive guard) route to review; NEVER silent.
    const skipped = new Set(applied.skippedExplanationTrims);
    const skippedReview = observations
      .filter((f) => f.detector === 'explanation-blocks' && f.target.draftIndex !== undefined && skipped.has(f.target.draftIndex))
      .map((f) => ({ reason: 'ambiguous-boundary' as const, detector: 'explanation-blocks', page: f.target.page, draftIndex: f.target.draftIndex, detail: { ...f.evidence, declinedTrim: true } }));
    const routedReview = [...this.review.route(reviewRemaining), ...skippedReview];
    const reconciliation = this.reconciler.reconcile(
      allDrafts.length,
      final.length,
      structure.expectedQuestionCount,
      routedReview.length,
    );

    const finalIdx = new Set(final.map((d) => d.index));
    const completionMap = new Map(
      completionBoundaries
        .filter((b) => finalIdx.has(b.draftIndex))
        .map((b) => [b.draftIndex, { complete: b.complete, completeAtY: b.completeAtY }]),
    );
    const reviewIndices = new Set(routedReview.map((r) => r.draftIndex).filter((i): i is number => typeof i === 'number'));
    // lifecycle runs on the FINAL (corrected + trimmed + merged) draft set.
    const { lifecycle, emittedCount } = this.lifecycle.run(final, completionMap, reviewIndices, pctx, {
      start: [this.multiColumnStart, this.handwrittenStart], // START owners
      expand: [this.wideContentExpand, this.splitQuestionExpand, this.crossPageExpand], // EXPAND owners
      finalize: [this.explanationFinalize], // FINALIZE owner
    });

    this.logger.log(
      `paper: ocr=${allDrafts.length} → corrected=${corrected.length} → final=${final.length} ` +
        `(trims=${corrections.explanationTrims} splitMerges=${corrections.splitMerges} xpageMerges=${corrections.crossPageMerges}) ` +
        `emitted=${emittedCount} status=${reconciliation.status}`,
    );

    return {
      structure,
      ocrDraftCount: allDrafts.length,
      correctedDraftCount: final.length,
      autoFixed,
      reviewQueue: reviewRemaining,
      noOpCount,
      removedDraftIndices,
      completionBoundaries,
      reconciliation,
      routedReview,
      lifecycle,
      emittedCount,
      observations,
      allFindings,
      corrections,
      appliedProvenance,
    };
  }

  async analyzePage(
    pageImage: Buffer,
    pageIndex: number,
    drafts: ReadonlyArray<ShadowDraft>,
    words: ReadonlyArray<ShadowWord>,
  ): Promise<AnalysisReport> {
    const features = await this.analyzer.analyze(pageImage, pageIndex, words);
    const ctx: DetectorContext = { features, drafts, words };

    const findings = [];
    for (const det of this.detectors) {
      const fs = det.detect(ctx);
      for (const f of fs) {
        this.logger.debug(
          `[p${pageIndex}] ${det.name} → ${f.kind} conf=${f.confidence.toFixed(2)} tier=${tierOf(f.confidence)} ` +
            `(SHADOW, applied=NONE) ${JSON.stringify(f.evidence)}`,
        );
      }
      findings.push(...fs);
    }

    const integrity = this.validator.validate(ctx);

    this.logger.log(
      `[p${pageIndex}] analyzed: density=${features.textDensity} gutters=${features.gutters.length} ` +
        `numerals=${features.numerals.length} drafts=${drafts.length} findings=${findings.length} (SHADOW — nothing applied)`,
    );

    return {
      page: pageIndex,
      featuresSummary: {
        width: features.width,
        height: features.height,
        textDensity: features.textDensity,
        gutters: features.gutters.length,
        numerals: features.numerals.length,
        drafts: drafts.length,
      },
      findings,
      integrity,
      applied: 0,
    };
  }
}
