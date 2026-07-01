"""Continuation detection (responsibilities 3, and merge cases 5/6/7/10).

Two structural jobs:

  • false-start demotion — a "start" that is NOT a line start AND carries no parsed
    number is almost certainly a stray token inside a question, a diagram label, or an
    option value. It must NOT open a new question; its segment continues the previous
    one. This is what prevents a diagram between question and options (case 5/10) or a
    large internal whitespace gap (case 6) from being split when a spurious marker
    landed inside it.

  • internal-gap reporting — a big vertical whitespace gap with NO marker is NOT a
    question end (case 6). Segments are only ever cut at real starts, so this is
    already honoured; the detector just surfaces the signal for confidence.

Pure predicates over a Segment / its StartCandidate. Never splits, never crops.
"""
from __future__ import annotations

from typing import List

from .geometry import PageMetrics, group_lines
from .question_end_detector import Segment


def is_false_start(segment: Segment, metrics: "PageMetrics | None" = None) -> bool:
    """True when this segment's start should NOT begin a new question (merge it up).

    A real start is a line start OR carries a parsed number. A token that is neither a
    line start nor a number is a stray (a diagram label, an in-text figure, an option
    value) — it continues the previous question rather than opening a new one."""
    s = segment.start
    if (not s.line_start) and (s.num is None):
        return True
    # No number AND sitting well inside its column (not at the left margin) ⇒ inline
    # token, not a question opener.
    if s.num is None and metrics is not None:
        indent = s.x0 - segment.col_left
        if indent > max(6.0 * metrics.char_w, metrics.median_h) and not s.line_start:
            return True
    return False


def has_large_internal_gap(segment: Segment, metrics: PageMetrics) -> bool:
    """A vertical whitespace gap wider than several line-heights between consecutive
    text lines inside the segment. Informational only — it never ends a question."""
    lines = group_lines(segment.words, metrics.line_tol)
    if len(lines) < 2:
        return False
    gap_min = 4.0 * metrics.median_h
    ordered = sorted(lines, key=lambda ln: ln.y0)
    for a, b in zip(ordered, ordered[1:]):
        if (b.y0 - a.y1) > gap_min:
            return True
    return False


def demote_false_starts(segments: List[Segment]) -> List[int]:
    """Return the indices (into `segments`, reading order) of segments whose start is a
    false start and should merge UP into the preceding segment in the same column."""
    out: List[int] = []
    for i, seg in enumerate(segments):
        if i == 0:
            continue
        if seg.column != segments[i - 1].column:
            continue  # only merge up within the same column here; cross-column is its own detector
        if is_false_start(seg):
            out.append(i)
    return out
