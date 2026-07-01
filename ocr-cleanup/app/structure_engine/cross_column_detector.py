"""Cross-column ownership (responsibility 14; merge cases 1, 4, 9).

When a question's content/options spill into the NEXT column, the next column begins
with ORPHAN content above its own first start (or the whole column has no start). That
orphan region belongs to the LAST question of the PREVIOUS column — do NOT split it
into a new question. Detect it and emit an Attachment to that owner.

Same-page only; column-0 leading orphans are the cross-PAGE detector's job.
"""
from __future__ import annotations

from typing import List, Optional, Sequence

from . import tokens as _tokens
from .geometry import PageMetrics, group_lines
from .merge_types import Attachment
from .models import MergeCase, PageInput, WordBox
from .option_owner_detector import options_in_region
from .question_end_detector import Segment


def _meaningful(words: Sequence[WordBox], metrics: PageMetrics) -> bool:
    """The orphan region carries real content (an option line, or a line of ≥3 words)."""
    lines = group_lines(words, metrics.line_tol)
    for ln in lines:
        if len(ln.words) >= 3:
            return True
        if ln.words:
            from . import tokens
            if tokens.is_option_label(ln.words[0].text):
                return True
    return False


def _column_words(page: PageInput, metrics: PageMetrics, col_idx: int) -> List[WordBox]:
    if not metrics.columns or col_idx >= len(metrics.columns):
        return []
    c = metrics.columns[col_idx]
    return [w for w in page.words if c.left - 0.5 <= w.cx <= c.right + 0.5]


def _bound_to_first_option_block(orphan: List[WordBox], metrics: PageMetrics) -> List[WordBox]:
    """Isolate ONE question's spill from a column-top orphan: the continuation text + the FIRST complete
    option block, stopping at the paragraph gap before the NEXT question. Used when the next column has NO
    detected starts (its question numbers were unread), so the raw orphan is the whole column — attaching
    all of it would swallow several questions. Returns the bounded subset (or the input unchanged when no
    option block is present). Universal: option labels + a line-gap, no PDF constant."""
    mh = max(8.0, float(getattr(metrics, "median_h", 0)) or 12.0)
    lines = sorted(group_lines(orphan, metrics.line_tol), key=lambda ln: min(w.y0 for w in ln.words))
    opt_start = None
    for i, ln in enumerate(lines):
        ws = sorted(ln.words, key=lambda w: w.x0)
        if ws and _tokens.is_option_label(ws[0].text):
            opt_start = i
            break
    if opt_start is None:
        return orphan  # no option block here -> let the existing gates decide
    opt_end = opt_start
    for j in range(opt_start + 1, len(lines)):
        ws = sorted(lines[j].words, key=lambda w: w.x0)
        prev_y1 = max(w.y1 for w in lines[opt_end].words)
        cur_y0 = min(w.y0 for w in lines[j].words)
        is_opt = bool(ws) and _tokens.is_option_label(ws[0].text)
        # keep an option line, or a wrapped continuation of the last option (small gap); stop at a clear
        # paragraph gap (the next, undetected, question's stem starts there).
        if is_opt or (cur_y0 - prev_y1) < 0.9 * mh:
            opt_end = j
        else:
            break
    bound_y = max(w.y1 for w in lines[opt_end].words)
    return [w for w in orphan if w.y0 <= bound_y + 0.3 * mh]


def detect_cross_column(
    page: PageInput, metrics: PageMetrics, segments: List[Segment]
) -> List[Attachment]:
    if len(metrics.columns) < 2:
        return []
    by_col: dict[int, List[Segment]] = {}
    for s in segments:
        by_col.setdefault(s.column, []).append(s)

    attachments: List[Attachment] = []
    for col_idx in range(1, len(metrics.columns)):
        col = metrics.columns[col_idx]
        col_starts = sorted(by_col.get(col_idx, []), key=lambda s: s.y0)
        col_words = _column_words(page, metrics, col_idx)
        if not col_words:
            continue
        first_y = col_starts[0].y0 if col_starts else float("inf")
        orphan = [w for w in col_words if w.cy < first_y]
        if not orphan or not _meaningful(orphan, metrics):
            continue
        # OPTION-SPILL SIZE GATE — a real cross-column spill is a COMPACT block (the question's options /
        # a short continuation) at the TOP of the next column. When the orphan instead reaches deep down
        # the column, that column simply has UNDETECTED start markers (a poor scan where the next
        # questions' numbers were not read), so the whole column-top got lumped onto the previous question
        # — producing a crop that swallows several real questions. Treat that as undetected questions
        # (count/review path), not a spill. Universal: a fraction of the page height, no constant.
        # ESCAPE: a pure MCQ option-label block is structurally a spill (options never float free), not
        # undetected starts. Undetected starts would show question-number markers (blocked by the orphan
        # meaningful + option-label check). Allow up to 75 % depth for option-label orphans.
        oy1_top = max(w.y1 for w in orphan)
        if page.height and oy1_top > 0.50 * page.height:
            has_labels = any(_tokens.is_option_label(w.text) for w in orphan)
            if not (has_labels and oy1_top <= 0.75 * page.height):
                # The column has NO detected starts (its question numbers were unread), so the raw orphan is
                # the whole column. Isolate the OWNER's spill — continuation + its first option block — and
                # attach only that, leaving the rest for the (undetected) questions below. Only do this when
                # the column genuinely has no starts; a column WITH starts already bounds the orphan above.
                if not col_starts and has_labels:
                    bounded = _bound_to_first_option_block(orphan, metrics)
                    if bounded and len(bounded) < len(orphan) and _meaningful(bounded, metrics):
                        orphan = bounded
                        oy1_top = max(w.y1 for w in orphan)
                    else:
                        continue
                else:
                    continue

        owner = _last_segment_in_column(by_col, col_idx - 1)
        if owner is None:
            continue  # nothing to own it on this page → leave for cross-page

        opts = options_in_region(orphan, metrics, page.index, col.right)
        case = MergeCase.CROSS_COLUMN_OPTIONS if opts else MergeCase.MULTI_COLUMN
        # confidence: the owner reaching the column bottom and lacking a full option set
        # makes a spill far more likely.
        conf = 0.6
        if owner.reaches_column_bottom:
            conf += 0.2
        if opts and len(opts) <= 4:
            conf += 0.1
        ox0 = min(w.x0 for w in orphan)
        oy0 = min(w.y0 for w in orphan)
        ox1 = max(w.x1 for w in orphan)
        oy1 = max(w.y1 for w in orphan)
        attachments.append(
            Attachment(
                owner=owner,
                case=case,
                options=opts,
                region=(page.index, ox0, oy0, ox1, oy1),
                words=orphan,
                confidence=round(min(1.0, conf), 4),
                reason=f"col{col_idx}_leading_orphan",
            )
        )
    return attachments


def _last_segment_in_column(by_col: dict, col_idx: int) -> Optional[Segment]:
    segs = by_col.get(col_idx, [])
    if not segs:
        return None
    return max(segs, key=lambda s: s.y0)
