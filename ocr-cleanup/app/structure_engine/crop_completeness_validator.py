"""Crop completeness validation (responsibilities 8 incomplete crops, 21 invalid
crops, 22 broken options, 24 MCQ crop complete).

STRUCTURE-level completeness over a QuestionCandidate: a crop is incomplete only when it
is entirely empty (no number, no options, no diagram). Partial option sets (1–3 of 4) are
NOT hard failures — the pre_delivery_validator handles the active option search and the
ownership_completeness gate tracks missing labels separately. This lets the N=N=C integrity
gate and cropGate remain PASS for partial-option questions so crops are still delivered
(the question will show the partial options visible in the crop image).

Pure over the candidate; no pixels here.
"""
from __future__ import annotations

from collections import Counter
from typing import List, Sequence, Tuple

from .models import QuestionCandidate

FULL_OPTION_SET = 4  # default when the paper's count can't be inferred (4-option is the norm)


def infer_expected_options(questions: Sequence[QuestionCandidate]) -> int:
    """The paper's DOMINANT option count — inferred, never hardcoded. The mode of per-question
    option counts (over questions that actually carry options), clamped to [2,5]. A 5-option
    paper infers 5; a 4-option paper infers 4. Used so '3 of 4 found' is flagged for search."""
    counts = [q.option_count for q in questions if q.option_count >= 2]
    if not counts:
        return FULL_OPTION_SET
    dom = Counter(counts).most_common(1)[0][0]
    return max(2, min(5, dom))


def assess(question: QuestionCandidate, expected: int = FULL_OPTION_SET) -> Tuple[bool, List[str]]:  # noqa: ARG001
    """Return (complete, reasons). `complete` is about the CROP having all its parts.
    `expected` is kept in the signature for API compatibility (callers pass it); partial option
    sets are no longer a hard failure here — pre_delivery_validator handles the search+gate."""
    _ = expected  # kept for API compat; partial options handled by pre_delivery_validator
    reasons: List[str] = []
    hard_incomplete = False
    n = question.option_count

    if question.number is None:
        reasons.append("no_question_number")

    # No number, no options, no diagram → this is not a real question crop.
    if question.number is None and n == 0 and not question.has_diagram:
        reasons.append("empty_candidate")
        hard_incomplete = True

    return (not hard_incomplete), reasons
