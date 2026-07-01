import { Injectable } from '@nestjs/common';
import { BBox, BridgeQuestion, BridgeReport, PaperReport } from './contracts';

/**
 * PRODUCTION BRIDGE LAYER. Converts the framework's corrected output (PaperReport) into export-ready
 * logical-question objects — one per emitted crop, post-correction. It is a PURE transformation:
 * it builds objects only. It does NOT render images, write storage, export files, modify reviewers,
 * or touch live persistence / the engine. No PDF-centric behaviour, no values.
 *
 * Each object carries: questionId, source pages, final boundaries, merged regions, explanation-trim
 * boundary, Question+Options bbox, review status, confidence. Cross-column and cross-page questions
 * collapse into ONE object (the applier already merged them); explanation is already trimmed out of
 * the bbox (residual safety-skips are reported as leakage, not silently included).
 */
@Injectable()
export class ProductionBridge {
  build(report: PaperReport): BridgeReport {
    const provByIdx = new Map(report.appliedProvenance.map((p) => [p.draftIndex, p]));
    const reviewIdx = new Set(report.routedReview.map((r) => r.draftIndex).filter((i): i is number => typeof i === 'number'));
    // explanation onset y per draft (to detect residual leakage inside the emitted bbox)
    const onsetByIdx = new Map<number, number>();
    for (const f of report.observations) {
      if (f.detector !== 'explanation-blocks' || f.target.draftIndex === undefined) continue;
      const y = (f.evidence as { onsetY?: number }).onsetY;
      if (typeof y === 'number') onsetByIdx.set(f.target.draftIndex, Math.min(onsetByIdx.get(f.target.draftIndex) ?? Infinity, y));
    }

    let splitMergedObjects = 0;
    let crossPageMergedObjects = 0;
    let explanationLeakageObjects = 0;
    let silentLeakageObjects = 0;

    const questions: BridgeQuestion[] = report.lifecycle
      .filter((l) => l.emittedCrop)
      .map((l) => {
        const bbox = l.emittedCrop as BBox;
        const prov = provByIdx.get(l.draftIndex);
        const sourcePages = prov?.sourcePages?.length ? [...prov.sourcePages].sort((a, b) => a - b) : [l.page];
        const mergedRegions = prov?.mergedRegions?.length ? prov.mergedRegions : [bbox];
        const explanationTrimY = prov?.trimmedToY ?? null;
        if (sourcePages.length > 1) crossPageMergedObjects += 1;
        if (mergedRegions.length > 1 && sourcePages.length === 1) splitMergedObjects += 1;
        // residual explanation leakage: an onset still inside the (possibly untrimmed) bbox
        const onsetY = onsetByIdx.get(l.draftIndex);
        const leaks = typeof onsetY === 'number' && onsetY < bbox.y1;
        const reviewStatus: 'ok' | 'review' = l.needsReview || reviewIdx.has(l.draftIndex) ? 'review' : 'ok';
        if (leaks) { explanationLeakageObjects += 1; if (reviewStatus === 'ok') silentLeakageObjects += 1; }
        const confidence = Math.round((l.complete ? 0.95 : 0.7) * (reviewStatus === 'review' ? 0.8 : 1) * 100) / 100;

        return {
          questionId: `q-p${l.page}-d${l.draftIndex}`, // deterministic, stable; not random
          questionNumber: l.questionNumber,
          sourcePages,
          questionOptionsBbox: bbox,
          finalBoundaries: bbox,
          mergedRegions,
          explanationTrimY,
          reviewStatus,
          confidence,
        };
      });

    // object-level integrity
    const ids = new Set<string>();
    let duplicateObjects = 0;
    for (const q of questions) { if (ids.has(q.questionId)) duplicateObjects += 1; else ids.add(q.questionId); }
    const orphanObjects = questions.filter((q) => q.reviewStatus === 'review' && q.mergedRegions.length === 1 && q.questionNumber === null).length;
    const brokenBoundaryObjects = questions.filter((q) => q.questionOptionsBbox.x1 <= q.questionOptionsBbox.x0 || q.questionOptionsBbox.y1 <= q.questionOptionsBbox.y0).length;
    const logical = report.reconciliation.finalLogicalCount;

    return {
      questions,
      totalLogicalQuestions: logical,
      totalBridgeObjects: questions.length,
      nToN: questions.length === logical,
      duplicateObjects,
      orphanObjects,
      extraObjects: Math.max(0, questions.length - logical),
      missingObjects: Math.max(0, logical - questions.length),
      explanationLeakageObjects,
      silentLeakageObjects,
      brokenBoundaryObjects,
      splitMergedObjects,
      crossPageMergedObjects,
    };
  }
}
