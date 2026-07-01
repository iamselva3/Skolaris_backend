"""Merge detection — THE most important module. It composes the start/end/continuation/
cross-column/cross-page detectors into QuestionGroups, each being ONE question's full
ownership across blocks, columns and pages. It NEVER splits and NEVER crops; it only
groups segments and records WHY.

The 10 user cases map to structural rules here:
  1  question(left col) + options(right col)        → CROSS_COLUMN_OPTIONS
  2  question page N → ends page N+1                 → CROSS_PAGE_CONTINUATION
  3  question page N + options page N+1              → CROSS_PAGE_OPTIONS
  4  question one col + options another col          → CROSS_COLUMN_OPTIONS (no split)
  5  large diagram between question and options      → false-start fold / MULTI_BLOCK (no split)
  6  large whitespace                                → NOT an end (segments only cut at real starts)
  7  question spans multiple blocks                  → MULTI_BLOCK (false-start fold)
  8  question spans multiple pages                   → CROSS_PAGE_CONTINUATION
  9  question spans multiple columns                 → MULTI_COLUMN
  10 question + diagram + options                    → one ownership group (no split)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List

from .continuation_detector import is_false_start
from .cross_column_detector import detect_cross_column
from .cross_page_detector import detect_cross_page
from .geometry import PageMetrics
from .merge_types import Attachment
from .models import MergeCase, PageInput
from .question_end_detector import Segment


@dataclass
class QuestionGroup:
    primary: Segment
    merged_segments: List[Segment] = field(default_factory=list)
    attachments: List[Attachment] = field(default_factory=list)
    cases: List[MergeCase] = field(default_factory=list)

    @property
    def all_segments(self) -> List[Segment]:
        return [self.primary] + self.merged_segments


def _group_page(
    segments: List[Segment], metrics: PageMetrics
) -> List[QuestionGroup]:
    """Fold false starts up within a column → one group per TRUE start."""
    groups: List[QuestionGroup] = []
    for seg in segments:  # already in reading order (column, y0)
        if (
            groups
            and is_false_start(seg, metrics)
            and groups[-1].all_segments[-1].column == seg.column
        ):
            g = groups[-1]
            g.merged_segments.append(seg)
            if MergeCase.MULTI_BLOCK not in g.cases:
                g.cases.append(MergeCase.MULTI_BLOCK)
        else:
            groups.append(QuestionGroup(primary=seg))
    return groups


def build_groups(
    pages: List[PageInput],
    metrics_by_page: Dict[int, PageMetrics],
    segments_by_page: Dict[int, List[Segment]],
) -> List[QuestionGroup]:
    # 1) per-page grouping with false-start folding
    page_groups: Dict[int, List[QuestionGroup]] = {}
    all_groups: List[QuestionGroup] = []
    seg_to_group: Dict[int, QuestionGroup] = {}
    for p in pages:
        gs = _group_page(segments_by_page.get(p.index, []), metrics_by_page[p.index])
        page_groups[p.index] = gs
        for g in gs:
            for s in g.all_segments:
                seg_to_group[id(s)] = g
        all_groups.extend(gs)

    def attach(att: Attachment) -> None:
        owner_group = seg_to_group.get(id(att.owner))
        if owner_group is None:
            return  # owner not in any group (defensive) — drop the merge, never invent
        owner_group.attachments.append(att)
        if att.case not in owner_group.cases:
            owner_group.cases.append(att.case)

    # 2) cross-column attachments (same page)
    for p in pages:
        for att in detect_cross_column(p, metrics_by_page[p.index], segments_by_page.get(p.index, [])):
            attach(att)

    # 3) cross-page attachments (between consecutive pages)
    for prev, cur in zip(pages, pages[1:]):
        att = detect_cross_page(
            prev,
            metrics_by_page[prev.index],
            segments_by_page.get(prev.index, []),
            cur,
            metrics_by_page[cur.index],
            segments_by_page.get(cur.index, []),
        )
        if att is not None:
            attach(att)

    return all_groups
