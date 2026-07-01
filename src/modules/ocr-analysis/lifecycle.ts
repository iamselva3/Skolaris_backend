import { Injectable } from '@nestjs/common';
import {
  LifecycleHooks,
  LifecycleStage,
  PaperDetectorContext,
  QuestionLifecycle,
  ShadowDraft,
} from './contracts';

/**
 * QUESTION LIFECYCLE + BOUNDARY ENGINE (Phase 5). The reusable state machine every future detector
 * plugs into:
 *
 *   START → EXPAND → COMPLETE → FINALIZE → EMIT
 *
 * Phase 5 registers NO hooks, so it is a pure PASS-THROUGH: each corrected draft becomes exactly one
 * emitted Question+Options crop (one logical question = one crop). It NEVER creates a crop, NEVER
 * deletes one (upstream detectors already removed high-confidence phantoms), and NEVER gates emission
 * on the completeness check (which false-negatives on sparse OCR) — so clean papers are unchanged.
 * Uncertainty is carried as `needsReview` from the existing review signals; it is flagged, never
 * dropped (prefer NO-OP).
 *
 * Future ownership (each changes ONE stage, conservatively): Multi-column / Handwritten → START;
 * Wide Content / Split Q+O / Cross-page → EXPAND; Explanation Block → FINALIZE.
 *
 * Reuses no engine internals; consumes only the corrected drafts + completion boundaries.
 */
@Injectable()
export class QuestionLifecycleEngine {
  run(
    drafts: ReadonlyArray<ShadowDraft>,
    completion: ReadonlyMap<number, { complete: boolean; completeAtY: number | null }>,
    reviewIndices: ReadonlySet<number>,
    ctx: PaperDetectorContext,
    hooks: LifecycleHooks = {},
  ): { lifecycle: QuestionLifecycle[]; emittedCount: number } {
    const STAGES: LifecycleStage[] = ['START', 'EXPAND', 'COMPLETE', 'FINALIZE', 'EMIT'];
    const lifecycle = drafts.map((d) => {
      const base = d.coords ?? null;

      // START — where the question begins (future: Multi-column / Handwritten adjust this).
      let region = base;
      for (const h of hooks.start ?? []) if (region) region = h.adjustStart(d, region, ctx);
      const startRegion = region;

      // EXPAND — grow until complete (future: Wide Content / Split / Cross-page adjust this).
      for (const h of hooks.expand ?? []) if (region) region = h.adjustExpand(d, region, ctx);
      const expandedRegion = region;

      // COMPLETE — stem + options (+ required figure), from the Question Completion validator.
      const c = completion.get(d.index);
      const complete = c?.complete ?? false;
      const boundaryY = c?.completeAtY ?? null;

      // FINALIZE — lock the boundary (future: Explanation Block trims below boundaryY).
      for (const h of hooks.finalize ?? []) if (region) region = h.adjustFinalize(d, region, boundaryY);
      const emittedCrop = region;

      // EMIT — exactly one crop. Prefer NO-OP: always emit the corrected draft; flag uncertainty.
      return {
        draftIndex: d.index,
        page: d.page,
        questionNumber: d.questionNumber,
        startRegion,
        expandedRegion,
        complete,
        boundaryY,
        emittedCrop,
        emitted: true,
        // NO SILENT FAILURE: an emitted crop that is not a complete Question+Options block (e.g. a
        // stem fragment whose continuation/options could not be safely merged) is FLAGGED for review
        // rather than delivered silently. Adds only a review flag — never merges, drops, or re-counts.
        needsReview: reviewIndices.has(d.index) || !complete,
        stages: STAGES,
      };
    });
    return { lifecycle, emittedCount: lifecycle.length };
  }
}
