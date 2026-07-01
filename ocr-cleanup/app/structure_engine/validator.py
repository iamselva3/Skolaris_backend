"""Internal consistency validator — the LAST structural pass before the proposal goes
to TS. It cross-checks the whole analysis (never persists, never crops) and sets the
document `recommendation` ('ACCEPT' | 'REVIEW'). This recommendation is advisory: TS
still runs its own validation and is the only authority that persists.

Checks:
  • overlap conflict — two questions whose PRIMARY boxes overlap on the same page+column
    (a genuine ownership conflict) → both route to review.
  • N=N sanity — emitted question count vs the sequence's expected contiguous range.
  • ACCEPT only when nothing is flagged for review, no orphans, and no sequence anomaly.
"""
from __future__ import annotations

from typing import List

from .models import DocumentAnalysis, QuestionCandidate


def _primary_box(q: QuestionCandidate):
    return q.boxes[0] if q.boxes else None


def _overlap(a, b) -> float:
    """Vertical overlap fraction of two boxes on the same page (0 if different page)."""
    if a is None or b is None or a.page != b.page:
        return 0.0
    top = max(a.y0, b.y0)
    bot = min(a.y1, b.y1)
    inter = max(0.0, bot - top)
    smaller = max(1.0, min(a.y1 - a.y0, b.y1 - b.y0))
    return inter / smaller


def finalize(analysis: DocumentAnalysis) -> None:
    qs: List[QuestionCandidate] = analysis.questions
    notes: List[str] = []

    # overlap conflicts (same page+column primaries overlapping)
    for i in range(len(qs)):
        bi = _primary_box(qs[i])
        for j in range(i + 1, len(qs)):
            bj = _primary_box(qs[j])
            if bi is None or bj is None or bi.page != bj.page:
                continue
            # same column → compare centers within a column width
            if abs(bi.x0 - bj.x0) > (bi.x1 - bi.x0):
                continue
            if _overlap(bi, bj) >= 0.5:
                for q in (qs[i], qs[j]):
                    if "overlap_conflict" not in q.review_reasons:
                        q.review_reasons = sorted(set(q.review_reasons + ["overlap_conflict"]))
                        q.needs_review = True
                notes.append(f"overlap_conflict:{qs[i].id}~{qs[j].id}")

    # N=N sanity vs the sequence's contiguous range
    seq = analysis.sequence
    if seq.expected_range:
        lo, hi = seq.expected_range
        expected = hi - lo + 1
        emitted = len(qs)
        if seq.gaps:
            notes.append(f"sequence_gaps:{len(seq.gaps)}")
        if emitted != expected and not seq.duplicates:
            notes.append(f"count_mismatch:emitted={emitted},expected~={expected}")

    any_review = any(q.needs_review for q in qs)
    clean = (not any_review) and (not analysis.orphans) and (not seq.duplicates) \
        and (not seq.question_zero) and (not seq.impossible)
    analysis.recommendation = "ACCEPT" if clean else "REVIEW"
    analysis.notes.extend(notes)
