"""Question END detection (responsibility 2) — turn each START into a provisional
SEGMENT bounded by the next same-column start (or the column's content bottom), and
flag whether content runs to the column / page bottom. Those flags are what the
continuation, cross-column and cross-page detectors consume to decide a merge.

NEVER crops, NEVER splits — it only computes structural bounds and flags.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

from .geometry import Column, PageMetrics
from .models import PageInput, WordBox
from .question_start_detector import StartCandidate


@dataclass
class Segment:
    page: int
    column: int
    num_x0: float           # left x of the question-number marker
    y0: float
    y1: float
    col_left: float
    col_right: float
    start: StartCandidate
    reaches_column_bottom: bool = False
    reaches_page_bottom: bool = False
    words: List[WordBox] = field(default_factory=list)

    @property
    def x0(self) -> float:
        return min(self.col_left, self.num_x0)

    @property
    def x1(self) -> float:
        return self.col_right


def _col_bounds(metrics: PageMetrics, idx: int) -> Column:
    if metrics.columns and 0 <= idx < len(metrics.columns):
        return metrics.columns[idx]
    return Column(left=metrics.content_x0, right=metrics.content_x1)


def _words_in(page: PageInput, col: Column, y0: float, y1: float) -> List[WordBox]:
    out = []
    for w in page.words:
        if y0 - 0.5 <= w.cy < y1 + 0.5 and col.left - 0.5 <= w.cx <= col.right + 0.5:
            out.append(w)
    return out


def compute_segments(
    page: PageInput, metrics: PageMetrics, starts: List[StartCandidate]
) -> List[Segment]:
    if not starts:
        return []
    segments: List[Segment] = []
    # group starts by column
    by_col: dict[int, List[StartCandidate]] = {}
    for s in starts:
        by_col.setdefault(s.column, []).append(s)

    page_bottom = metrics.content_y1
    near = max(1.5 * metrics.median_h, 0.01 * (page.height or metrics.content_y1))

    for col_idx, col_starts in by_col.items():
        col = _col_bounds(metrics, col_idx)
        col_starts = sorted(col_starts, key=lambda s: s.y0)
        # the column's actual ink bottom (content can extend below the last marker)
        col_words = [w for w in page.words if col.left - 0.5 <= w.cx <= col.right + 0.5]
        col_bottom = max((w.y1 for w in col_words), default=page_bottom)

        for i, s in enumerate(col_starts):
            y0 = s.y0
            if i + 1 < len(col_starts):
                y1 = col_starts[i + 1].y0
                reaches_col_bottom = False
            else:
                y1 = col_bottom
                reaches_col_bottom = True
            seg = Segment(
                page=page.index,
                column=col_idx,
                num_x0=s.x0,
                y0=y0,
                y1=y1,
                col_left=col.left,
                col_right=col.right,
                start=s,
                reaches_column_bottom=reaches_col_bottom,
                reaches_page_bottom=reaches_col_bottom and (col_bottom >= page_bottom - near),
                words=_words_in(page, col, y0, y1),
            )
            segments.append(seg)

    # global reading order across the page: column, then top-to-bottom
    segments.sort(key=lambda s: (s.column, s.y0))
    return segments
