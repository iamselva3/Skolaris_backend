import { Injectable } from '@nestjs/common';
import { Finding, ReviewItem, ReviewReason } from './contracts';

/**
 * REVIEW QUEUE routing (Phase 4). Routes ONLY the items that genuinely need a human:
 *   - ambiguous duplicates  (Duplicate-Numbering MEDIUM findings)
 *   - ambiguous boundaries  (Question-Completion option-only / incomplete findings)
 *   - low-confidence        (Content-Numeral MEDIUM findings)
 *
 * It does NOT route clean papers: a clean paper produces zero MEDIUM findings and zero option-only
 * orphans, so its routed review is empty. Routing is classification only — it never edits a crop.
 */
@Injectable()
export class ReviewQueueRouter {
  route(reviewFindings: ReadonlyArray<Finding>): ReviewItem[] {
    return reviewFindings.map((f) => ({
      reason: this.reasonFor(f.detector),
      detector: f.detector,
      page: f.target.page,
      draftIndex: f.target.draftIndex,
      detail: f.evidence,
    }));
  }

  private reasonFor(detector: string): ReviewReason {
    if (detector === 'duplicate-numbering') return 'ambiguous-duplicate';
    if (detector === 'question-completion') return 'ambiguous-boundary';
    return 'low-confidence';
  }
}
