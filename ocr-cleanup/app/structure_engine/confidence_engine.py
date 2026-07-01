"""Confidence engine — fuse the structural signals into a per-question and a
whole-document confidence in [0,1]. Confidence is ADVISORY: it is reported to TS so TS
can weight its own validation; it never on its own causes a persist. Review routing
(review_router) uses discrete structural anomalies, not a bare confidence cutoff, so
there is no magic threshold to tune.
"""
from __future__ import annotations

from typing import List, Tuple

from .models import DocumentAnalysis, QuestionCandidate

# Decision matrix (Python = PRIMARY intelligence, TS = SAFETY AUTHORITY). The tier names
# the validation level TS applies — Python NEVER auto-accepts on its own; TS always
# validates and persists. On a 0..100 scale:
#   >= 98  → TS_LIGHTWEIGHT : TS does lightweight validation, then accepts
#   95–97  → TS_FULL        : TS does full validation, then accepts or reviews
#   <  95  → REVIEW         : too uncertain — route to review
# (Python⇄TS disagreement and N=N=C failure also force REVIEW, enforced in the TS seam.)
LIGHTWEIGHT_PCT = 98
FULL_PCT = 95


def tier_for(pct: int) -> str:
    if pct >= LIGHTWEIGHT_PCT:
        return "TS_LIGHTWEIGHT"
    if pct >= FULL_PCT:
        return "TS_FULL"
    return "REVIEW"


def assign_tier(q: QuestionCandidate) -> Tuple[int, str]:
    pct = int(round(q.confidence * 100))
    # A question already routed to review is REVIEW tier by definition — high raw
    # confidence can never lift a flagged question out of review.
    if q.needs_review:
        return pct, "REVIEW"
    return pct, tier_for(pct)


def score_question(q: QuestionCandidate) -> float:
    """Start from the number-marker confidence, then adjust by structural quality."""
    c = q.number_confidence if q.number is not None else 0.35

    if q.complete:
        c += 0.20
    else:
        c -= 0.25

    # a full option set is strong corroboration; a partial one is a red flag
    if q.option_count >= 4:
        c += 0.10
    elif 0 < q.option_count < 4:
        c -= 0.15

    # merges are the CORRECT outcome, but cross-page/column ownership is inherently less
    # certain than a single-block question — reflect that mild reduction.
    if q.multi_page:
        c -= 0.05
    if q.multi_column:
        c -= 0.03

    if q.needs_review:
        c -= 0.15
        c = min(c, 0.80)  # any validation failure → clearly below the review threshold

    # Global ceiling 0.99 — no structural analysis reaches perfect certainty. A crop that
    # passed every check can still have undetected content issues; 1.00 would be misleading.
    return round(max(0.0, min(0.99, c)), 4)


def score_document(analysis: DocumentAnalysis) -> float:
    qs: List[QuestionCandidate] = analysis.questions
    if not qs:
        return 0.0
    mean_q = sum(q.confidence for q in qs) / len(qs)
    c = mean_q

    # penalties for document-level anomalies
    review_ratio = sum(1 for q in qs if q.needs_review) / len(qs)
    c -= 0.4 * review_ratio
    if analysis.orphans:
        c -= min(0.2, 0.02 * len(analysis.orphans))
    seq = analysis.sequence
    if seq.duplicates:
        c -= min(0.15, 0.03 * len(seq.duplicates))
    if seq.question_zero:
        c -= 0.1
    if seq.impossible:
        c -= min(0.15, 0.03 * len(seq.impossible))

    return round(max(0.0, min(1.0, c)), 4)
