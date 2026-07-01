import { Injectable } from '@nestjs/common';
import { BridgeReport, DeliveryDecision, DeliverySplitSignal } from './contracts';

/**
 * DELIVERY GATE (TASK 2 + SAFE SPLIT FALLBACK). Final pre-delivery check over the bridge output. A PDF
 * is DELIVERABLE only if it passes ALL hard criteria; otherwise the ENTIRE PDF is routed to review
 * (never silently delivered). Per-question low-confidence cases are flagged for review but do not fail
 * the PDF.
 *
 * SAFE SPLIT FALLBACK: a split that the Split Detector could not PROVE mergeable surfaces as an
 * unresolved orphan. When such an orphan exists AND Question+Options completeness < 100%, delivery is
 * BLOCKED with reason `split-question-unresolved` (reviewRequired = true) — never silently passed,
 * delivered, or reviewed. This is a hard blocker, not an auto-merge: it guarantees we never ship a
 * Question without options or options without a question.
 *
 * Pure decision; no rendering, no storage, no persistence. Reuses the existing framework output only.
 */
@Injectable()
export class DeliveryGate {
  decide(bridge: BridgeReport, split?: DeliverySplitSignal): DeliveryDecision {
    const reasons: string[] = [];
    if (!bridge.nToN) reasons.push('N≠N (logical ≠ emitted)');
    if (bridge.duplicateObjects > 0) reasons.push(`${bridge.duplicateObjects} duplicate`);
    if (bridge.missingObjects > 0) reasons.push(`${bridge.missingObjects} missing`);
    if (bridge.extraObjects > 0) reasons.push(`${bridge.extraObjects} extra`);
    if (bridge.brokenBoundaryObjects > 0) reasons.push(`${bridge.brokenBoundaryObjects} broken boundaries`);
    if (bridge.orphanObjects > 0) reasons.push(`${bridge.orphanObjects} orphan`);
    if (bridge.silentLeakageObjects > 0) reasons.push(`${bridge.silentLeakageObjects} silent solution leakage`);
    // SAFE SPLIT FALLBACK — unprovable split ⇒ hard delivery blocker (never silent).
    if (split && split.unresolvedSplitOrphans > 0 && split.questionOptionsCompletePct < 100) {
      reasons.push(`split-question-unresolved (${split.unresolvedSplitOrphans} orphan region(s), completeness ${split.questionOptionsCompletePct}%)`);
    }

    const status = reasons.length === 0 ? 'DELIVER' : 'REVIEW_ENTIRE_PDF';
    const reviewQuestions = bridge.questions.filter((q) => q.reviewStatus === 'review').length;
    return {
      status,
      reasons,
      deliveredQuestions: status === 'DELIVER' ? bridge.questions.length : 0,
      reviewQuestions: status === 'DELIVER' ? reviewQuestions : bridge.questions.length,
      reviewRequired: status === 'REVIEW_ENTIRE_PDF',
    };
  }
}
