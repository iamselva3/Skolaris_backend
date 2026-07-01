"""Ownership-driven SOLUTION boundary — decide where a question's OWNED content ends so the crop excludes
the worked solution, WITHOUT keyword-only matching and WITHOUT ever touching the next question.

A question owns:  number -> text -> continuations -> visuals -> OPTIONS.  The crop must END at the last
owned option / owned visual. A worked SOLUTION begins only AFTER the last owned option.

Why this is not trivial: the platform OCR garbles math option labels ('C) 1/2,1,1/2' -> 'CESS',
'D) -1,1/2' -> 'B11'), so label detection alone under-counts options and the solution-cap can't fire.
This module recovers the full option BLOCK by POSITION — a short row directly below the detected option
labels that ALIGNS to the option columns (a 2-up grid's C/D row, with a clear central gutter) is part of
the block even when its labels are unreadable. The block ENDS at the first FULL-WIDTH paragraph row (or a
clear vertical gap). Content below the block is a SOLUTION only when MULTIPLE signals agree (an explanation
cue OR math-formula density). Anything else below the options (an owned diagram/table) is KEPT.

Golden rule: if the option block can't be confirmed, return None => KEEP PIXELS (never cut).
"""
from __future__ import annotations

import re
from typing import List, Optional, Sequence, Tuple

from .geometry import PageMetrics, group_lines
from .models import WordBox

# Explanation SIGNALS — a worked-solution cue. Used ONLY together with POSITION (below the option block)
# and structure; NEVER as a standalone keyword cut. Pattern-based, no institute/PDF constant.
_EXPL = re.compile(
    r"^[\(\[]?\s*(sol|soln|solution|ans|answer|explanation|hint|reason|therefore|hence|thus|so\b|"
    r"substitut|solving|equating|put|putting|from\s+eq|by\s+using|we\s+(get|have|obtain)|on\s+solving)",
    re.IGNORECASE,
)
# STRONG cue — a line that UNAMBIGUOUSLY opens a worked-solution block ('SOL:', 'Solution:', 'Ans:',
# 'Explanation:'). Used for a question with NO option block (numeric / visual), where weak cues
# ('therefore', 'so', 'hence') also occur in the QUESTION prose and must never trigger a cut.
_EXPL_STRONG = re.compile(
    r"^[\(\[]?\s*(sol|soln|solution|ans|answer|explanation|hint)\s*[:.\)]", re.IGNORECASE
)

_Box = Tuple[float, float, float, float]  # (x0, y0, x1, y1)


def _option_columns(options: Sequence[_Box], mh: float) -> List[float]:
    """Distinct left-x columns of the option labels (1 = stacked options, 2 = a 2-up A|B / C|D grid)."""
    cols: List[float] = []
    for x in sorted(o[0] for o in options):
        if not cols or x - cols[-1] > 4.0 * mh:
            cols.append(x)
    return cols


def question_crop_end(
    options: Sequence[_Box],
    page_words: Sequence[WordBox],
    metrics: PageMetrics,
    col_left: float,
    col_right: float,
    region_bottom: Optional[float] = None,
    owned_visuals: Optional[Sequence[_Box]] = None,
    content_top: Optional[float] = None,
) -> Optional[float]:
    """Bottom-y to cap the crop at so the SOLUTION is excluded, or None => KEEP PIXELS.

    options: this question's detected option-label boxes ON THIS PAGE+COLUMN (>=2 required for the MCQ path).
    region_bottom: the NEXT question's marker top in this column (so the solution scan never reads the
        following question's content as this question's solution). None = no bound (scan to page end).
    owned_visuals: this question's owned figure/table/equation/chem boxes on this page+column — the crop
        boundary is EXTENDED through any that sit between the options and the solution (a question diagram
        is a PROTECTED region: KEEP it; the solution begins only AFTER the last owned figure).
    content_top: the question's own top-y on this page (number/first box). Enables the NO-OPTIONS path
        (numeric / visual question): with no option block to anchor on, the solution is cut ONLY at a STRONG
        cue ('SOL:'/'Solution:'/'Ans:') below the content — keeping the stem + any diagram above it.
    """
    mh = max(8.0, float(getattr(metrics, "median_h", 0)) or 12.0)
    _in_col = lambda x0, x1: (col_left - 2.0) <= (x0 + x1) / 2.0 <= (col_right + 2.0)
    if len(options) < 2:
        # NO-OPTIONS (numeric / visual): never use the option block or a weak cue. Cut ONLY at a STRONG
        # solution marker line below the question's content and before the next owner; never inside a
        # protected figure. Keeps everything (stem + diagram) above the cue. KEEP PIXELS when no strong cue.
        if content_top is None:
            return None
        bound = region_bottom if region_bottom is not None else float("inf")
        cues = [
            w for w in page_words
            if content_top + 0.8 * mh < w.y0 < bound and not getattr(w, "protected", False)
            and _in_col(w.x0, w.x1) and _EXPL_STRONG.match((w.text or "").strip())
        ]
        if not cues:
            return None
        return min(w.y0 for w in cues) - 0.3 * mh
    cols = _option_columns(options, mh)
    two_up = len(cols) >= 2
    gutter = (cols[0] + cols[-1]) / 2.0 if two_up else None
    opt_bottom = max(o[3] for o in options)
    col_w = max(1.0, col_right - col_left)

    lines = sorted(group_lines(page_words, metrics.line_tol), key=lambda ln: min(w.y0 for w in ln.words))

    # 1) extend the option block DOWN through positionally-aligned rows (recovers garbled C/D).
    block_end = opt_bottom
    for ln in lines:
        ws = ln.words
        if not ws:
            continue
        y0 = min(w.y0 for w in ws)
        y1 = max(w.y1 for w in ws)
        if y0 <= opt_bottom - mh:
            continue  # at/above the option labels -> still inside the stem/options, skip
        if y0 > block_end + 1.6 * mh:
            break  # a clear vertical gap after the block -> the option block has ended
        lx0 = min(w.x0 for w in ws)
        lx1 = max(w.x1 for w in ws)
        starts_at_col = lx0 >= cols[0] - 1.5 * mh  # not LEFT of the option column (a 'SOL:' at the margin)
        if two_up and gutter is not None:
            straddles = any(w.x0 < gutter < w.x1 for w in ws)  # a token crossing the gutter = full-width prose
            has_left = any(abs(w.x0 - cols[0]) < 3.0 * mh for w in ws)
            has_right = any(abs(w.x0 - cols[-1]) < 3.0 * mh for w in ws)
            grid_row = starts_at_col and not straddles and has_left and has_right
        else:
            grid_row = starts_at_col and (lx1 - lx0) < 0.6 * col_w  # short, left-aligned single-column option
        if grid_row:
            block_end = y1
        else:
            break  # first non-grid (full-width / margin) row after the options -> block ends here

    in_col = lambda x0, x1: (col_left - 2.0) <= (x0 + x1) / 2.0 <= (col_right + 2.0)
    bound = region_bottom if (region_bottom is not None) else float("inf")

    # 1b) EXTEND the boundary THROUGH any PROTECTED region (a question diagram / table / formula) that sits
    #     BETWEEN the options and the solution — it is a PROTECTED region and must be KEPT, never cut. The
    #     solution begins only AFTER the last owned figure. A figure is "contiguous below" when it starts
    #     within ~2 lines of the running boundary; iterate so a chain of figures all extend it. Never crosses
    #     the next question's marker. Two sources of figure geometry (union, for robustness): the owned
    #     visual boxes AND words the figure detector tagged `protected`.
    fig_boxes: List[_Box] = list(owned_visuals or [])
    extended = True
    while extended:
        extended = False
        for (vx0, vy0, vx1, vy1) in fig_boxes:
            if vy1 > block_end + 1.0 and vy0 <= block_end + 2.0 * mh and vy1 < bound and in_col(vx0, vx1):
                block_end = vy1
                extended = True
    # protected (figure) WORDS contiguous below — extend through them too (catches a figure the owner graph
    # did not attach, so its labels/strokes are never cut).
    prot = sorted(
        (w for w in page_words if getattr(w, "protected", False) and w.y0 > block_end and w.y1 < bound
         and in_col(w.x0, w.x1)),
        key=lambda w: w.y0,
    )
    for w in prot:
        if w.y0 <= block_end + 2.0 * mh:
            block_end = max(block_end, w.y1)

    # 2) is the content BELOW the last owned element a SOLUTION? Only cut on MULTI-signal agreement, and only
    #    on NON-protected content (never analyse inside a protected figure). Scope the scan to THIS question's
    #    region (above the next question's marker) so the FOLLOWING question is never read as this solution.
    top_lim = block_end + 0.3 * mh
    bot_lim = bound if bound > top_lim else float("inf")
    below = [
        w for w in page_words
        if top_lim < w.y0 < bot_lim and not getattr(w, "protected", False) and in_col(w.x0, w.x1)
    ]
    if not below:
        return None  # nothing owned below the options here -> let the normal owned/slab bound stand
    # The SOLUTION is anchored by an EXPLANATION CUE (SOL:/Solution:/Therefore/...) AFTER the last owned
    # element and BEFORE the next owner. Formula density ALONE is NOT enough: a CHEMICAL STRUCTURE or a
    # QUESTION formula below the options is formula-dense but is NOT a solution (e.g. PHYCHE Q32's B/C/D are
    # CH3/HC structures). So a chemical/question formula is KEPT; the cut fires only when a real explanation
    # cue is present (then formula density just confirms it is a worked solution, not a one-line aside).
    cue_words = [w for w in below if _EXPL.match((w.text or "").strip())]
    if not cue_words:
        return None  # no explanation cue -> a diagram / chemical structure / question formula -> KEEP PIXELS
    # cut at the FIRST explanation cue (the solution start) — keeps any question diagram/structure ABOVE it.
    cue_top = min(w.y0 for w in cue_words)
    return max(block_end, cue_top - 0.3 * mh)
