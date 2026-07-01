import { Injectable } from '@nestjs/common';
import { DetectorContribution, PaperReport, ValidationReport } from './contracts';

/**
 * ENTERPRISE VALIDATION LAYER (shadow reporting only). For ANY uploaded MCQ PDF it turns the
 * framework's PaperReport into the enterprise validation report. It is a PURE function over the
 * report — no detection, no engine, no persistence, no PDF/institute/value-specific logic. It
 * proves the generic invariant "N logical questions → N emitted crops, 1 question = 1 crop" and
 * surfaces every leakage/duplicate/orphan/extra metric.
 *
 * It NEVER targets the reference PDFs: it computes the same metrics for whatever paper is fed in.
 */
@Injectable()
export class EnterpriseValidator {
  validate(report: PaperReport): ValidationReport {
    const logical = report.reconciliation.finalLogicalCount;
    const emitted = report.emittedCount;

    // (3)/(6) — emitted vs logical (equal by construction; report any drift)
    const missingQuestions = Math.max(0, logical - emitted);
    const extraCrops = Math.max(0, emitted - logical);

    // (4) duplicates in the EMITTED set. Bad duplicates were auto-fixed upstream; a same-number group
    // still present is a legitimate section restart. A duplicate whose draft was flagged-but-still-emitted
    // counts as BAD. Group emitted lifecycle by question number.
    const byNum = new Map<number, number>();
    for (const l of report.lifecycle) if (typeof l.questionNumber === 'number') byNum.set(l.questionNumber, (byNum.get(l.questionNumber) ?? 0) + 1);
    const legitimateDuplicateGroups = [...byNum.values()].filter((c) => c > 1).length;
    const emittedIdx = new Set(report.lifecycle.map((l) => l.draftIndex));
    const duplicateQuestions = report.allFindings.filter(
      (f) => f.detector === 'duplicate-numbering' && f.outcome !== 'auto-fix' && f.draftIndex !== undefined && emittedIdx.has(f.draftIndex),
    ).length;

    // (5) orphan crops still emitted (split-question orphans that were not removed)
    const orphanCrops = report.allFindings.filter(
      (f) => f.detector === 'split-question-options' && f.draftIndex !== undefined && emittedIdx.has(f.draftIndex),
    ).length;

    // (7) Q+O completeness across emitted crops
    const completeCount = report.lifecycle.filter((l) => l.complete).length;
    const questionOptionsCompletePct = emitted ? Math.round((completeCount / emitted) * 1000) / 10 : 0;

    // (8) explanation leakage — an explanation block STILL inside the emitted (post-trim) crop.
    // After Explanation Trim the crop bottom (emittedCrop.y1) sits above the onset ⇒ no leakage.
    const emittedY1 = new Map<number, number>();
    for (const l of report.lifecycle) emittedY1.set(l.draftIndex, l.emittedCrop ? l.emittedCrop.y1 : Number.POSITIVE_INFINITY);
    const explanationLeakageCrops = report.observations.filter((f) => {
      if (f.detector !== 'explanation-blocks' || f.target.draftIndex === undefined || !emittedIdx.has(f.target.draftIndex)) return false;
      const onsetY = (f.evidence as { onsetY?: number }).onsetY ?? 0;
      const y1 = emittedY1.get(f.target.draftIndex) ?? Number.POSITIVE_INFINITY;
      return onsetY < y1; // onset still within the emitted crop ⇒ leaking
    }).length;

    // (9) review queue
    const reviewQueueItems = report.routedReview.length;

    // (10) N → N
    const nToN = emitted === logical;

    // (11) per-detector contributions
    const detectorContributions = this.contributions(report);

    const zeroDuplicateCrops = duplicateQuestions === 0;
    const zeroOrphanCrops = orphanCrops === 0;
    const zeroExtraCrops = extraCrops === 0;
    const zeroExplanationLeakage = explanationLeakageCrops === 0;
    const oneQuestionOneCrop = nToN && zeroExtraCrops && zeroOrphanCrops;
    const blockedByDeferredApplication: string[] = [];
    if (!zeroExplanationLeakage) blockedByDeferredApplication.push(`${explanationLeakageCrops} explanation crop(s) NOT trimmed (anti-aggressive safety skip — needs review)`);
    if (questionOptionsCompletePct < 100) blockedByDeferredApplication.push('Q+O completeness < 100% reflects OCR-text completeness (isCompleteBlock), not crop integrity — not a correction these 4 ops apply');

    return {
      totalLogicalQuestions: logical,
      totalEmittedCrops: emitted,
      missingQuestions,
      duplicateQuestions,
      legitimateDuplicateGroups,
      orphanCrops,
      extraCrops,
      questionOptionsCompletePct,
      explanationLeakageCrops,
      reviewQueueItems,
      nToN,
      detectorContributions,
      acceptance: {
        nToN,
        oneQuestionOneCrop,
        zeroDuplicateCrops,
        zeroOrphanCrops,
        zeroExtraCrops,
        zeroExplanationLeakage,
        pass: nToN && oneQuestionOneCrop && zeroDuplicateCrops && zeroOrphanCrops && zeroExtraCrops && zeroExplanationLeakage,
        blockedByDeferredApplication,
      },
    };
  }

  private contributions(report: PaperReport): DetectorContribution[] {
    const byDet = new Map<string, DetectorContribution>();
    for (const f of report.allFindings) {
      let c = byDet.get(f.detector);
      if (!c) {
        c = { detector: f.detector, findings: 0, confidenceMin: null, confidenceMax: null, autoFix: 0, review: 0, observe: 0, noOp: 0 };
        byDet.set(f.detector, c);
      }
      c.findings += 1;
      c.confidenceMin = c.confidenceMin === null ? f.confidence : Math.min(c.confidenceMin, f.confidence);
      c.confidenceMax = c.confidenceMax === null ? f.confidence : Math.max(c.confidenceMax, f.confidence);
      if (f.outcome === 'auto-fix') c.autoFix += 1;
      else if (f.outcome === 'review') c.review += 1;
      else if (f.outcome === 'observe') c.observe += 1;
      else c.noOp += 1;
    }
    return [...byDet.values()].sort((a, b) => a.detector.localeCompare(b.detector));
  }
}
