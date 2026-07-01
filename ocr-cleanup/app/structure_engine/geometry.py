"""Dynamic page geometry — the ONLY place thresholds are derived, and they derive
ENTIRELY from the document itself: the median glyph height/width and whitespace
projections. There are NO absolute coordinates, no BACKGROUND_THRESHOLD / HEADER_Y /
DIVIDER_X here — only ratios of the page's own measured text size.

Pure functions + small dataclasses, no IO. Independently testable.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from statistics import median
from typing import List, Optional, Sequence

from .models import PageInput, WordBox


@dataclass
class TextLine:
    words: List[WordBox]
    y0: float
    y1: float
    x0: float
    x1: float

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2.0


@dataclass
class Column:
    left: float
    right: float

    def contains_cx(self, cx: float) -> bool:
        return self.left - 0.5 <= cx <= self.right + 0.5


@dataclass
class PageMetrics:
    """All values are DERIVED — never configured."""
    median_h: float          # median word height (the document's glyph scale)
    char_w: float            # estimated single-character width
    line_tol: float          # vertical tolerance for "same line" (0.6 * median_h)
    clear_left: float        # horizontal clear space that proves a line-start (2 * median_h)
    content_x0: float
    content_x1: float
    content_y0: float
    content_y1: float
    columns: List[Column] = field(default_factory=list)
    lines: List[TextLine] = field(default_factory=list)

    def column_of(self, cx: float) -> int:
        """Index of the column a center-x falls into; 0 if single/unknown."""
        for i, c in enumerate(self.columns):
            if c.contains_cx(cx):
                return i
        if not self.columns:
            return 0
        # NOT inside any column (a gutter / left-margin x). A line-START — a question NUMBER especially —
        # sits in the LEFT MARGIN of its column, which for the RIGHT column lands in the inter-column
        # GUTTER (left of that column's text). So an x between two columns belongs to the column it
        # PRECEDES (the next column to its right), NOT the geometrically-nearest one — assigning a
        # right-column question's gutter number to the LEFT column made it cap the previous left-column
        # question's crop (cutting its diagram/options). Choose the column whose left edge is the nearest
        # one to the RIGHT of cx; if cx is right of every column, the last column; else nearest by center.
        right_of = [(c.left, i) for i, c in enumerate(self.columns) if c.left > cx]
        if right_of:
            return min(right_of)[1]
        # cx is at/after the last column's left edge but outside it ⇒ the last (right-most) column
        return len(self.columns) - 1


def median_height(words: Sequence[WordBox]) -> float:
    hs = [w.h for w in words if w.h > 0]
    return float(median(hs)) if hs else 20.0


def estimate_char_width(words: Sequence[WordBox]) -> float:
    """Median per-character width across multi-char tokens — the document's own
    monospace-equivalent. Falls back to ~0.5 * median height."""
    per = [w.w / len(w.text) for w in words if len(w.text) >= 2 and w.w > 0]
    if per:
        return float(median(per))
    mh = median_height(words)
    return mh * 0.5


def group_lines(words: Sequence[WordBox], line_tol: float) -> List[TextLine]:
    """Group words into text lines by vertical proximity. A new line starts when a
    word's center jumps more than `line_tol` from the running line's center."""
    if not words:
        return []
    ordered = sorted(words, key=lambda w: (w.cy, w.x0))
    lines: List[TextLine] = []
    cur: List[WordBox] = [ordered[0]]
    cur_cy = ordered[0].cy
    for w in ordered[1:]:
        if abs(w.cy - cur_cy) <= line_tol:
            cur.append(w)
            cur_cy = sum(x.cy for x in cur) / len(cur)
        else:
            lines.append(_mk_line(cur))
            cur = [w]
            cur_cy = w.cy
    lines.append(_mk_line(cur))
    return lines


def _mk_line(ws: List[WordBox]) -> TextLine:
    ws = sorted(ws, key=lambda w: w.x0)
    return TextLine(
        words=ws,
        y0=min(w.y0 for w in ws),
        y1=max(w.y1 for w in ws),
        x0=min(w.x0 for w in ws),
        x1=max(w.x1 for w in ws),
    )


def detect_columns(
    words: Sequence[WordBox],
    page_width: float,
    median_h: float,
    lines: Optional[Sequence[TextLine]] = None,
) -> List[Column]:
    """Detect column gutters from the x-projection of word ink.

    A gutter is a maximal vertical whitespace band that (a) is at least as wide as a
    derived minimum (≈ 2 line-heights, also floored at a small fraction of the page),
    (b) has substantial word ink on BOTH sides, and (c) is crossed by only a SMALL
    fraction of text lines. Condition (c) is what makes a wide diagram/table/heading
    that bridges the gutter (merge cases 5/7) NOT destroy the column boundary — those
    few crossings are tolerated; a band crossed by most lines is just inter-word space.
    """
    inked = [w for w in words if w.w > 0]
    if not inked or page_width <= 0:
        return []
    cx0 = min(w.x0 for w in inked)
    cx1 = max(w.x1 for w in inked)
    if cx1 <= cx0:
        return []

    if lines is None:
        lines = group_lines(words, median_h * 0.6)
    n_lines = max(1, len(lines))

    # LINE-COVERAGE x-profile (robust to a full-width banner). cover[x] counts how many text LINES have
    # ink at x — NOT whether ANY word does. A column gutter is blank on the BODY lines even when a
    # page-wide HEADER / table / diagram crosses it. The old zero-ink projection was defeated by exactly
    # such a banner: a single full-width header line filled every gutter pixel, so NO gutter was ever
    # found → the page collapsed to one full-width column and every crop spanned BOTH columns (the
    # "179 random full-width cuts" bug). Counted per-line, a 2-line header contributes only 2/n_lines of
    # coverage at the gutter — far under the threshold — so the true gutter survives the banner.
    span = int(round(cx1 - cx0)) + 1
    diff = [0] * (span + 1)
    for ln in lines:
        ivs = sorted(
            (max(0, int(round(w.x0 - cx0))), min(span - 1, int(round(w.x1 - cx0))))
            for w in ln.words
            if w.w > 0 and w.x1 > w.x0
        )
        merged: List[tuple[int, int]] = []  # union the line's word spans so overlap counts once
        for a, b in ivs:
            if merged and a <= merged[-1][1] + 1:
                merged[-1] = (merged[-1][0], max(merged[-1][1], b))
            else:
                merged.append((a, b))
        for a, b in merged:
            diff[a] += 1
            diff[min(span, b + 1)] -= 1
    cover = [0] * span
    run = 0
    for i in range(span):
        run += diff[i]
        cover[i] = run

    # a gutter is a maximal run of x crossed by only a SMALL fraction of lines (the banner), blank on
    # the rest. Threshold derived from the line count — no absolute constant.
    thr = max(1.0, 0.15 * n_lines)
    gutters: List[tuple[float, float]] = []
    i = 0
    while i < span:
        if cover[i] < thr:
            j = i
            while j < span and cover[j] < thr:
                j += 1
            gutters.append((cx0 + i, cx0 + j - 1))
            i = j
        else:
            i += 1

    # A real column gutter is clear space ≥ ~2.5 glyph-heights wide; narrower low-coverage runs are
    # intra-column word gaps (aligned whitespace between two words on sparse lines), NOT a column break.
    # Derived from the doc's own glyph scale — no absolute/PDF constant.
    gutter_min = max(2.5 * median_h, 0.025 * page_width)
    valid: List[tuple[float, float]] = []
    for gx0, gx1 in gutters:
        if (gx1 - gx0) < gutter_min:
            continue
        if gx0 <= cx0 + 0.5 or gx1 >= cx1 - 0.5:
            continue  # an edge margin, not an internal gutter
        gm = (gx0 + gx1) / 2.0
        both = 0
        for ln in lines:
            has_left = any(w.x1 <= gm for w in ln.words)
            has_right = any(w.x0 >= gm for w in ln.words)
            if has_left and has_right:
                both += 1
        # a real column boundary has content on BOTH sides on a meaningful share of lines.
        if both >= 0.30 * n_lines:
            valid.append((gx0, gx1))

    if not valid:
        return [Column(left=cx0, right=cx1)]

    valid.sort()
    cols: List[Column] = []
    left = cx0
    for gx0, gx1 in valid:
        cols.append(Column(left=left, right=gx0))
        left = gx1
    cols.append(Column(left=left, right=cx1))

    # MERGE DEGENERATE (too-narrow) columns — two spurious gutters detected close together leave a SLIVER
    # column only a few pixels wide (a watermark stroke / stray ink island between them, e.g. a scanned 2-up
    # page whose detection yields [39,688],[736,739],[856,1437] — the 3px middle is noise). Such a sliver
    # then mis-routes a whole page's questions (full-width binding). A REAL question column spans a
    # substantial fraction of the page, so any column narrower than that is absorbed into its neighbour.
    # Document-derived (glyph scale + page width), no PDF constant.
    if len(cols) > 1:
        col_min = max(3.0 * median_h, 0.03 * page_width)
        out: List[Column] = [cols[0]]
        for c in cols[1:]:
            if (c.right - c.left) < col_min or (out[-1].right - out[-1].left) < col_min:
                out[-1] = Column(left=out[-1].left, right=c.right)
            else:
                out.append(c)
        cols = out
    return cols


def compute_metrics(page: PageInput) -> PageMetrics:
    """Derive every per-page structural metric from the page's own words."""
    words = page.words
    mh = median_height(words)
    cw = estimate_char_width(words)
    tol = mh * 0.6
    lines = group_lines(words, tol)
    if words:
        cx0 = min(w.x0 for w in words)
        cx1 = max(w.x1 for w in words)
        cy0 = min(w.y0 for w in words)
        cy1 = max(w.y1 for w in words)
    else:
        cx0 = cy0 = 0.0
        cx1 = page.width
        cy1 = page.height
    cols = detect_columns(words, page.width or (cx1 - cx0), mh, lines)
    return PageMetrics(
        median_h=mh,
        char_w=cw,
        line_tol=tol,
        clear_left=mh * 2.0,
        content_x0=cx0,
        content_x1=cx1,
        content_y0=cy0,
        content_y1=cy1,
        columns=cols,
        lines=lines,
    )
