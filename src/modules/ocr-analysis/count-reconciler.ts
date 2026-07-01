import { Injectable } from '@nestjs/common';
import { Reconciliation, ReconciliationStatus } from './contracts';

/**
 * COUNT RECONCILIATION layer (Phase 4). Reconciles three counts — OCR count, corrected count (after
 * high-confidence auto-fixes), and the expected logical count N (derived from page/marker/region/
 * SECTION structure) — into a final logical question count + a decision.
 *
 * Hard rules: it NEVER invents a question and NEVER deletes one. The final logical count is exactly
 * the corrected count (only evidence-backed high-confidence fixes are reflected); anything uncertain
 * is routed to the review queue, not auto-adjusted.
 *
 *   all three agree, no review items            → PASS
 *   corrected == expected, high-fixes explain ocr gap, no review items → RECONCILED
 *   any disagreement OR ambiguous items remain  → NEEDS_REVIEW (investigate; never auto-adjust)
 */
@Injectable()
export class CountReconciler {
  reconcile(ocrCount: number, correctedCount: number, expectedCount: number, reviewItemCount: number): Reconciliation {
    const notes: string[] = [];
    const finalLogicalCount = correctedCount; // never invent / never delete beyond applied fixes

    let status: ReconciliationStatus;
    if (ocrCount === correctedCount && correctedCount === expectedCount && reviewItemCount === 0) {
      status = 'PASS';
      notes.push('all counts agree; no corrections applied');
    } else if (correctedCount === expectedCount && reviewItemCount === 0) {
      status = 'RECONCILED';
      notes.push(`${ocrCount - correctedCount} phantom(s) auto-fixed (high confidence); corrected == expected`);
    } else {
      status = 'NEEDS_REVIEW';
      if (correctedCount !== expectedCount) {
        notes.push(`corrected(${correctedCount}) != expected(${expectedCount}) — investigate; do NOT auto-invent or delete`);
      }
      if (reviewItemCount > 0) notes.push(`${reviewItemCount} ambiguous/low-confidence item(s) routed to review`);
    }
    return { ocrCount, correctedCount, expectedCount, finalLogicalCount, status, notes };
  }
}
