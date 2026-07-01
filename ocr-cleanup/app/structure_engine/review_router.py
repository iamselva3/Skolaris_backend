"""Review router — the embodiment of "never silently deliver incorrect output". A
question routes to REVIEW when ANY discrete structural anomaly applies. Routing is by
explicit anomaly, NOT by a bare confidence cutoff (so there is no threshold to tune
and an uncertain item is never quietly accepted).

Anomalies → review:
  • no readable question number
  • the number is implicated by the sequence validator (duplicate / zero / impossible)
  • the crop is structurally incomplete (broken option set / empty candidate)
  • the question owns an orphan with uncertain ownership (handled at document level)
"""
from __future__ import annotations

from typing import List

from . import crop_completeness_validator as completeness
from .models import QuestionCandidate, SequenceReport
from .sequence_validator import numbers_needing_review


def route(questions: List[QuestionCandidate], sequence: SequenceReport, expected_options: int = 4) -> None:
    """Mutate each question's `complete`, `needs_review`, `review_reasons` in place.
    `expected_options` = the paper's inferred dominant option count."""
    flagged_numbers = numbers_needing_review(sequence)

    for q in questions:
        reasons: List[str] = []

        complete, c_reasons = completeness.assess(q, expected_options)
        q.complete = complete
        reasons.extend(c_reasons)

        if q.number is None:
            if "no_question_number" not in reasons:
                reasons.append("no_question_number")
        elif q.number in flagged_numbers:
            if q.number in sequence.duplicates:
                reasons.append("duplicate_number")
            if sequence.question_zero and q.number <= 0:
                reasons.append("question_zero")
            if any(q.number in (t["prev"], t["next"]) for t in sequence.impossible):
                reasons.append("impossible_sequence")

        if not complete:
            reasons.append("incomplete_crop")

        q.review_reasons = sorted(set(reasons))
        q.needs_review = len(q.review_reasons) > 0
