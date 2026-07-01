"""Option ownership (responsibilities 7, 22, 23, 24).

Find MCQ option lines (a line whose leftmost token is an option label '(1)'/'a)'/…)
and bind them to the question segment that owns them. Detecting option lines that
appear with NO preceding start in their region is exactly the orphan signal the
cross-column / cross-page detectors use to merge them back to the right question.

Pure geometry + token shape; never reads option semantics.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

from . import tokens
from .geometry import PageMetrics, group_lines
from .models import OptionRef, WordBox
from .question_end_detector import Segment


@dataclass
class OptionLine:
    label: Optional[str]
    x0: float
    y0: float
    x1: float
    y1: float


def find_option_lines(
    words: Sequence[WordBox],
    metrics: PageMetrics,
    figure_boxes: Optional[Sequence[Tuple[float, float, float, float]]] = None,
) -> List[OptionLine]:
    """Option labels anywhere on a line — handles 2-up / multi-column option layouts
    (`A) … B) …` on one line). A token is a real option label when it has the option-label
    shape AND either begins a column by a clear horizontal gap, OR x-ALIGNS with another option
    label on a different line (i.e. it sits at the head of a real option COLUMN). The column rule
    is what recovers the top-right option in a tight 2×2 grid where the left option's text runs
    close to the right label (the gap test alone would drop it). Unit symbols like `(m)`/`(K)`
    never match the label shape, so they are naturally excluded; a stray inline `(b)` in prose is
    excluded too because it aligns with nothing.

    `figure_boxes` (x0,y0,x1,y1 in this page's word space) are detected diagram/figure regions: a token
    whose CENTRE sits inside one is a diagram point/axis/vertex LABEL ("A","C","B"), NOT an MCQ option —
    it is rejected before the column/gap tests so a labelled figure never spawns phantom options (which
    would then drive the solution-trim to slice the figure)."""
    gap = max(metrics.char_w * 2.0, metrics.median_h)
    col_tol = max(metrics.char_w * 1.5, 8.0)
    lines = list(group_lines(words, metrics.line_tol))

    def _in_figure(w: WordBox) -> bool:
        # Fast path: word was tagged protected in pipeline step 2d.1 (inside a detected figure).
        # Checking the flag avoids re-computing box containment on every option candidate.
        if getattr(w, 'protected', False):
            return True
        if not figure_boxes:
            return False
        cx, cy = (w.x0 + w.x1) / 2.0, (w.y0 + w.y1) / 2.0
        for (fx0, fy0, fx1, fy1) in figure_boxes:
            if fx0 <= cx <= fx1 and fy0 <= cy <= fy1:
                return True
        return False

    # Column starts: x0 buckets shared by >= 2 option-label candidates on DIFFERENT lines — a real
    # option column (A/C above one another, B/D above one another), not a one-off inline match.
    from collections import defaultdict

    bucket_rows: defaultdict = defaultdict(set)
    for ln in lines:
        for w in ln.words:
            if tokens.is_option_label(w.text) and not _in_figure(w):
                bucket_rows[round(w.x0 / col_tol)].add(round(ln.y0))
    column_buckets = {b for b, rows in bucket_rows.items() if len(rows) >= 2}

    out: List[OptionLine] = []
    for ln in lines:
        toks = ln.words  # sorted by x
        options_on_line = 0  # count of option labels already accepted on this line
        for i, w in enumerate(toks):
            if not tokens.is_option_label(w.text):
                continue
            if _in_figure(w):
                continue  # a label INSIDE a diagram is not an option
            if getattr(w, 'chrome', False):
                continue  # repeated header/footer chrome — never an MCQ option
            gap_start = i == 0 or (w.x0 - toks[i - 1].x1) >= gap
            col_start = round(w.x0 / col_tol) in column_buckets
            # A second (or later) option label on the same line continues a multi-up grid
            # (A … B …, C … D …). Accept it even when the gap to the previous WORD is small
            # and the column bucket threshold wasn't reached — the previous accepted option on
            # this line guarantees the overall line is an option row, so its partner is too.
            line_continue = options_on_line > 0
            if not (gap_start or col_start or line_continue):
                continue
            options_on_line += 1
            # the option spans from this label to just before the next option on the line
            x1 = ln.x1
            for nxt in toks[i + 1:]:
                if tokens.is_option_label(nxt.text) and (nxt.x0 - w.x0) > gap:
                    x1 = nxt.x0
                    break
            out.append(
                OptionLine(label=tokens.option_label_value(w.text), x0=w.x0, y0=ln.y0, x1=x1, y1=ln.y1)
            )
    return out


_ROMAN_VALUES = {"i", "ii", "iii", "iv", "v"}


def _dominant_family(lines: List[OptionLine]) -> List[OptionLine]:
    """A question carries ONE option family. Roman labels (i/ii/iii/iv) are ambiguous — an
    option family on a roman-only paper, but a STATEMENT enumeration when the same question
    also carries a Latin family (1)(2)(3)(4) / (a)(b)(c)(d). When BOTH appear, the roman
    labels are sub-statements inside the stem, not options — drop them so a 4-option question
    is not over-counted as 8. Latin-only or roman-only sets are returned unchanged."""
    has_latin = any((ol.label or "") not in _ROMAN_VALUES and ol.label is not None for ol in lines)
    has_roman = any((ol.label or "") in _ROMAN_VALUES for ol in lines)
    if has_latin and has_roman:
        return [ol for ol in lines if (ol.label or "") not in _ROMAN_VALUES]
    return lines


def _dedup_labels(lines: List[OptionLine]) -> List[OptionLine]:
    """Keep one entry per distinct label (first occurrence by reading order). A wrapped
    option whose 2nd line has no label is naturally excluded (it has label None at the
    head only when it actually starts with a label)."""
    seen = set()
    out: List[OptionLine] = []
    for ol in sorted(lines, key=lambda o: (o.y0, o.x0)):
        key = ol.label if ol.label is not None else f"_{round(ol.y0)}"
        if key in seen:
            continue
        seen.add(key)
        out.append(ol)
    return out


def options_for_segment(
    segment: Segment,
    metrics: PageMetrics,
    figure_boxes: Optional[Sequence[Tuple[float, float, float, float]]] = None,
) -> List[OptionRef]:
    # Exclude the question-stem line: a marker like "1." has the SAME shape as an option
    # label, so the segment's own start line must never be counted as an option.
    start_y = segment.start.y0
    lines = [
        ol
        for ol in find_option_lines(segment.words, metrics, figure_boxes)
        if abs(ol.y0 - start_y) > metrics.line_tol
    ]
    lines = _dominant_family(_dedup_labels(lines))
    return [
        OptionRef(
            label=ol.label,
            page=segment.page,
            x0=ol.x0,
            y0=ol.y0,
            x1=max(ol.x1, segment.col_right),
            y1=ol.y1,
        )
        for ol in lines
    ]


def options_in_region(
    words: Sequence[WordBox], metrics: PageMetrics, page: int, col_right: float,
    figure_boxes: Optional[Sequence[Tuple[float, float, float, float]]] = None,
) -> List[OptionRef]:
    """Option lines anywhere in an arbitrary region (used for orphan options that lead
    a column/page before any question start)."""
    lines = _dominant_family(_dedup_labels(find_option_lines(words, metrics, figure_boxes)))
    return [
        OptionRef(
            label=ol.label, page=page, x0=ol.x0, y0=ol.y0, x1=max(ol.x1, col_right), y1=ol.y1
        )
        for ol in lines
    ]
