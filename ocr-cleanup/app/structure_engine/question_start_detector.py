"""Question START detection (responsibility 1).

TS already proposes number-markers (line-start tokens that look like a question
number). Python re-validates each STRUCTURALLY — a real start sits at a line start
with clear horizontal space to its left within ITS column, and carries a plausible
number — and scores a confidence. Python adds no OCR: it only reasons over the
geometry of the tokens TS handed it.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

from .geometry import PageMetrics
from .models import Marker, PageInput
from . import tokens


@dataclass
class StartCandidate:
    page: int
    num: Optional[int]
    punct: str
    x0: float
    y0: float
    y1: float
    column: int
    line_start: bool
    confidence: float
    # Right edge of the question-number marker glyph. Carried so the crop layer can LOCK the
    # number's own box (x0..x1, y0..y1) and prove it is visible in the delivered crop. Defaults
    # to x0 (a zero-width box) when a caller has no width — never used as a real bound then.
    x1: float = 0.0

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2.0


def _is_line_start(marker: Marker, page: PageInput, metrics: PageMetrics) -> bool:
    """Clear horizontal space (≈2 line-heights) to the marker's left on its own line.
    A column gutter to the left counts as clear space, so a marker at the left margin
    of the 2nd/3rd column still qualifies (column-agnostic, like the TS rule)."""
    cy = marker.cy
    tol = metrics.line_tol
    clear = metrics.clear_left
    for w in page.words:
        if abs(w.cy - cy) > tol:
            continue
        if w.x1 <= marker.x0 and (marker.x0 - w.x1) < clear:
            # a token sits just to the left on the same line — but if a column gutter
            # lies between them, it is still a line start.
            gutter_between = any(
                c.right <= marker.x0 and c.right >= w.x1 for c in metrics.columns
            )
            if not gutter_between:
                return False
    return True


def detect_starts(page: PageInput, metrics: PageMetrics) -> List[StartCandidate]:
    out: List[StartCandidate] = []
    for m in page.markers:
        ls = _is_line_start(m, page, metrics)
        col = metrics.column_of((m.x0 + m.x1) / 2.0)
        # confidence: line-start is the strong structural signal; a parsed number and a
        # left-margin position add to it; a marker mid-column with no number is weak.
        conf = 0.4
        if ls:
            conf += 0.35
        if m.num is not None:
            conf += 0.15
        # near its column's left edge (within a few char-widths) → strongly a start
        col_left = metrics.columns[col].left if metrics.columns else metrics.content_x0
        if abs(m.x0 - col_left) <= max(metrics.char_w * 3, metrics.median_h):
            conf += 0.10
        # Defensive: a NUMBERLESS option-shaped token is not a question start. A marker
        # that carries a parsed number IS a question number even though "1." shares the
        # option-label shape — so only demote when there is no number.
        if m.num is None and tokens.is_option_label(_marker_text(page, m)):
            conf = min(conf, 0.2)
        out.append(
            StartCandidate(
                page=page.index,
                num=m.num,
                punct=m.punct,
                x0=m.x0,
                y0=m.y0,
                y1=m.y1,
                column=col,
                line_start=ls,
                confidence=round(min(1.0, conf), 4),
                x1=m.x1,
            )
        )
    # reading order: column, then top-to-bottom
    out.sort(key=lambda s: (s.column, s.y0, s.x0))
    return out


def _marker_text(page: PageInput, marker: Marker) -> str:
    """Best-effort text under a marker (the nearest word at the marker's position)."""
    for w in page.words:
        if abs(w.x0 - marker.x0) < 1 and abs(w.y0 - marker.y0) < 1:
            return w.text
    return ""
