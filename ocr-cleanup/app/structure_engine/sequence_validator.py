"""Sequence validation (responsibilities 4 duplicate numbers, 5 Question 0,
6 impossible sequences).

Reasons purely over the question NUMBERS that TS's OCR produced (Python never reads
them itself). A duplicate, a zero/negative, or an out-of-order/implausible jump is a
structural anomaly that means a number was misread or ownership is wrong — so the
affected questions route to review, never silently persist.

Thresholds for "implausible jump" derive from the document's own number span — there
is no hardcoded maximum question count.
"""
from __future__ import annotations

from typing import List

from .models import QuestionCandidate, SequenceReport


def validate_sequence(questions: List[QuestionCandidate]) -> SequenceReport:
    nums_in_order = [q.number for q in questions if q.number is not None]
    report = SequenceReport()
    if not nums_in_order:
        return report

    lo, hi = min(nums_in_order), max(nums_in_order)
    report.expected_range = [lo, hi]

    # duplicates
    seen = {}
    for n in nums_in_order:
        seen[n] = seen.get(n, 0) + 1
    report.duplicates = sorted([n for n, c in seen.items() if c > 1])

    # question zero / negative
    report.question_zero = any(n <= 0 for n in nums_in_order)

    # gaps: numbers missing inside the observed contiguous range (only when the range
    # is plausibly dense — span not absurdly larger than the count).
    span = hi - lo + 1
    if span <= 3 * max(1, len(set(nums_in_order))):
        present = set(nums_in_order)
        report.gaps = [n for n in range(lo, hi + 1) if n not in present]

    # impossible transitions: a DECREASE in reading order, or a forward jump so large
    # it cannot be a normal increment given the document's own number density.
    density_step = max(2, int(span / max(1, len(nums_in_order))) * 3)
    prev = None
    for n in nums_in_order:
        if prev is not None:
            if n < prev:
                report.impossible.append({"prev": prev, "next": n, "reason": "decrease"})
            elif (n - prev) > density_step + 5:
                report.impossible.append({"prev": prev, "next": n, "reason": "large_jump"})
        prev = n

    return report


def numbers_needing_review(report: SequenceReport) -> set:
    """The set of question NUMBERS implicated by the sequence report (duplicates, zero/
    negative, and both endpoints of every impossible transition)."""
    flagged: set = set(report.duplicates)
    if report.question_zero:
        flagged.add(0)
    for t in report.impossible:
        flagged.add(t["prev"])
        flagged.add(t["next"])
    return flagged
