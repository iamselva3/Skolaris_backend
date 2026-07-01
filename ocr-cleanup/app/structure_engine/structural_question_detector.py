"""Structural (numberless) question detection — recover a question whose NUMBER the OCR never read.

A question's most reliable signature is NOT its number (a faint/badged '11.' is often missed) but its
OPTION BLOCK: every MCQ ends in a complete set of option labels — (1)(2)(3)(4), (a)(b)(c)(d), True/False —
laid out at the column's left margin. So the count of option blocks in a column == the count of questions,
even when half the numbers are unreadable. This module finds option blocks that NO detected number marker
owns and emits a numberless START at the stem above each, so the normal segmenter/crop pipeline delivers
that question's crop. It runs AFTER figure detection (so diagram point-labels are already excluded) and
BEFORE segmentation.

Universal, not per-PDF: the "complete block" threshold is derived from the document's OWN dominant option
count; no institute/number constant. Conservative — KEEP PIXELS: a block that is not clearly a complete,
uncovered option set yields nothing (a missed question is better recovered than a phantom invented).
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

from .geometry import PageMetrics, group_lines
from .models import Marker, PageInput
from .option_owner_detector import _dominant_family, find_option_lines

Box = Tuple[float, float, float, float]


def _option_blocks(opt_lines, median_h: float) -> List[list]:
    """Cluster option lines into BLOCKS (one block ≈ one question's option set). Lines within ~3 text
    lines of each other are the same block; a larger vertical gap starts a new question's block."""
    if not opt_lines:
        return []
    ols = sorted(opt_lines, key=lambda o: o.y0)
    blocks = [[ols[0]]]
    for ol in ols[1:]:
        if ol.y0 - blocks[-1][-1].y1 <= 3.0 * median_h:
            blocks[-1].append(ol)
        else:
            blocks.append([ol])
    return blocks


def _family(label) -> str:
    """Coarse family of an option label so ANSWER options (1/2/3/4) are told apart from STATEMENT
    enumerations (A/B/C/D, a/b/c/d, i/ii/iii/iv) that live inside a question stem."""
    if label is None:
        return "?"
    if label in ("i", "ii", "iii", "iv", "v"):
        return "roman"
    if str(label).isdigit():
        return "num"
    if str(label).isalpha():
        return "upper" if str(label).isupper() else "lower"
    return "other"


def infer_answer_family(pages: Sequence[PageInput], metrics_by_page: Dict[int, PageMetrics]) -> str:
    """The document's ANSWER option family — the MODE family among COMPLETE (>=3-label) blocks across all
    columns. On a standard MCQ paper this is 'num' ((1)(2)(3)(4)); statement/matching lists (A/B/C/D,
    i/ii/iii/iv) are a different family and so are NOT recovered as questions. Falls back to 'num'."""
    from collections import Counter

    fams: Counter = Counter()
    for p in pages:
        m = metrics_by_page.get(p.index)
        if not m or not m.columns:
            continue
        for col in m.columns:
            cw = [w for w in p.words if col.left - 0.5 <= w.cx <= col.right + 0.5]
            if not cw:
                continue
            for blk in _option_blocks(_dominant_family(find_option_lines(cw, m)), m.median_h or 18.0):
                labels = [ol.label for ol in blk if ol.label is not None]
                if len(set(labels)) >= 3:
                    fams[Counter(_family(l) for l in labels).most_common(1)[0][0]] += 1
    if not fams:
        return "num"
    return fams.most_common(1)[0][0]


def infer_expected_options(pages: Sequence[PageInput], metrics_by_page: Dict[int, PageMetrics]) -> int:
    """The document's DOMINANT option count — the mode of complete-block label counts across all columns.
    Falls back to 4 (the near-universal MCQ width) when there is not enough evidence."""
    from collections import Counter

    counts: Counter = Counter()
    for p in pages:
        m = metrics_by_page.get(p.index)
        if not m or not m.columns:
            continue
        for col in m.columns:
            cw = [w for w in p.words if col.left - 0.5 <= w.cx <= col.right + 0.5]
            if not cw:
                continue
            for blk in _option_blocks(_dominant_family(find_option_lines(cw, m)), m.median_h or 18.0):
                n = len({ol.label for ol in blk if ol.label is not None})
                if n >= 2:
                    counts[n] += 1
    if not counts:
        return 4
    return max(counts.items(), key=lambda kv: (kv[1], kv[0]))[0]


def recover_gap_questions(qpages, metrics_by_page, figures_by_page=None, expected_options=None) -> int:
    """EVIDENCE-BASED gap recovery (replaces the blanket option-block heuristic). Inject a question START
    ONLY where the detected NUMBER SEQUENCE has a hole — so a fully-numbered paper (no gap) is byte-identical
    and never inflated. Driven by sequence validation: structural candidates (a stem + complete option block
    with no marker) are accepted only when their reading-order position lands on a MISSING number — an
    INTERNAL gap (between two detected numbers) or the run BEFORE the first detected number down to 1. It
    NEVER invents trailing questions past the detected max (the source of clean-paper inflation). Returns the
    number of questions injected. Best-effort; never raises.

    `qpages`: the question PageInputs (markers already reconciled). `metrics_by_page`: per-page metrics.
    """
    try:
        figures_by_page = figures_by_page or {}
        if expected_options is None:
            expected_options = infer_expected_options(qpages, metrics_by_page)
        answer_family = infer_answer_family(qpages, metrics_by_page)

        def _col(m, mk):
            return m.column_of((mk.x0 + mk.x1) / 2.0)

        numbered = []  # ((page, col, y), num)
        for p in qpages:
            m = metrics_by_page.get(p.index)
            if not m:
                continue
            for mk in p.markers:
                if mk.num is not None:
                    numbered.append(((p.index, _col(m, mk), float(mk.y0)), int(mk.num)))
        if not numbered:
            return 0
        numbered.sort(key=lambda t: t[0])
        present = {n for _, n in numbered}

        cands = []  # ((page, col, y), page_obj, marker)
        for p in qpages:
            m = metrics_by_page.get(p.index)
            if not m:
                continue
            for nm in detect_structural_starts(p, m, expected_options, figures_by_page.get(p.index),
                                               answer_family=answer_family):
                cands.append(((p.index, _col(m, nm), float(nm.y0)), p, nm))
        if not cands:
            return 0

        # merged reading order: numbered ANCHORS + candidates
        items = [(k, "num", n, None, None) for k, n in numbered]
        items += [(k, "cand", None, p, nm) for k, p, nm in cands]
        items.sort(key=lambda t: t[0])

        injected = 0
        i = 0
        while i < len(items):
            if items[i][1] != "cand":
                i += 1
                continue
            prev_num = next((items[j][2] for j in range(i - 1, -1, -1) if items[j][1] == "num"), None)
            next_num = next((items[j][2] for j in range(i + 1, len(items)) if items[j][1] == "num"), None)
            run = []
            j = i
            while j < len(items) and items[j][1] == "cand":
                run.append(items[j]); j += 1
            if prev_num is not None and next_num is not None and (next_num - prev_num - 1) > 0:
                # INTERNAL gap. Injecting a start BETWEEN two detected markers re-bounds the previous
                # question (its slab moves up to the injected marker), so a FALSE candidate here splits a
                # real question into a numberless fragment (the AD regression). Safe internal recovery
                # requires a NON-INTERFERING post-process split of an already-merged question, not marker
                # injection — built separately. So internal injection is intentionally DISABLED here.
                pass
            elif prev_num is None and next_num is not None:
                for idx, it in enumerate(run):                        # before the first detected number → …→1
                    val = next_num - (len(run) - idx)
                    if val >= 1 and val not in present:
                        it[4].num = val; present.add(val)
                        it[3].markers.append(it[4]); injected += 1
            # prev set & next None (after the last number) → NO recovery: there is no sequence evidence of
            # how many trailing questions exist, and inventing them inflates a clean paper. Left for review.
            i = j
        if injected:
            for p in qpages:
                p.markers.sort(key=lambda x: x.y0)
        return injected
    except Exception:  # noqa: BLE001
        return 0


def detect_structural_starts(
    page: PageInput,
    metrics: PageMetrics,
    expected_options: int,
    figure_boxes: Optional[Sequence[Box]] = None,
    answer_family: Optional[str] = None,
) -> List[Marker]:
    """Numberless START markers for COMPLETE option blocks in `page` that no existing number marker owns.

    For each column: find option blocks, drop the ones a detected marker already sits above, and for each
    remaining COMPLETE block (>= expected-1 distinct labels, floor 2) emit a marker at the stem line that
    begins the question — the first content line after the previous block, bounded by the block top. Never
    raises; returns [] when nothing qualifies."""
    if not metrics.columns:
        return []
    mh = metrics.median_h or 18.0
    need = max(2, expected_options - 1)  # tolerate ONE garbled/missed label in an otherwise full set
    out: List[Marker] = []
    for col_idx, col in enumerate(metrics.columns):
        cw = [w for w in page.words
              if col.left - 0.5 <= w.cx <= col.right + 0.5 and not getattr(w, "chrome", False)]
        if not cw:
            continue
        opt_lines = _dominant_family(find_option_lines(cw, metrics, figure_boxes))
        blocks = _option_blocks(opt_lines, mh)
        if not blocks:
            continue
        marker_ys = sorted(
            float(mk.y0) for mk in page.markers
            if col.left - 0.5 <= (mk.x0 + mk.x1) / 2.0 <= col.right + 0.5
        )
        all_lines = sorted(group_lines(cw, metrics.line_tol), key=lambda ln: min(w.y0 for w in ln.words))
        prev_bottom = float("-inf")
        for blk in blocks:
            blk_top = min(ol.y0 for ol in blk)
            blk_bot = max(ol.y1 for ol in blk)
            labels = {ol.label for ol in blk if ol.label is not None}
            if len(labels) < need:
                prev_bottom = blk_bot
                continue  # not a complete option set — could be a statement enumeration / partial
            # ANSWER-FAMILY GATE: a question is recovered only on its ANSWER option block (the document's
            # dominant family, e.g. numeric (1)(2)(3)(4)); a STATEMENT enumeration (A)(B)(C)(D) / (i)(ii)…
            # inside a stem is a different family and must NOT spawn a question (the matching-grid false
            # positive). When the family can't be inferred, this gate is skipped (answer_family=None).
            if answer_family is not None:
                from collections import Counter as _Counter
                blk_fam = _Counter(_family(l) for l in labels).most_common(1)[0][0]
                if blk_fam != answer_family:
                    prev_bottom = blk_bot
                    continue
            # already-owned: a detected number marker sits in this question's region (above its options)
            region_lo = prev_bottom
            if any(region_lo < my < blk_top + 0.5 * mh for my in marker_ys):
                prev_bottom = blk_bot
                continue
            # the question STEM = content lines between the previous block and this block's options
            stem = [ln for ln in all_lines
                    if min(w.y0 for w in ln.words) > prev_bottom + 0.3 * mh
                    and max(w.y1 for w in ln.words) <= blk_top + 0.5 * mh]
            # A real RECOVERABLE question has a SUBSTANTIAL stem (>=2 multi-word lines) in THIS column above
            # its options. A 1-line block at the column top is a CONTINUATION whose real stem is in the
            # previous column/page (the cross-column / cross-page detectors own it) — recovering it here
            # would DUPLICATE that question. So require a multi-line stem AND skip blocks whose stem begins
            # in the column-top continuation zone.
            stem_text = [ln for ln in stem if len(ln.words) >= 2]
            if len(stem_text) < 2:
                prev_bottom = blk_bot
                continue
            start = stem_text[0]
            sy0 = min(w.y0 for w in start.words)
            sy1 = max(w.y1 for w in start.words)
            # A block at the top of a RIGHT column (col_idx > 0) is a cross-column CONTINUATION whose real
            # stem is in the left column — recovering it would duplicate that question (the "How far…" bug).
            # The LEFT column's top is where the document's / page's first real question lives (Q1 sits just
            # under the header), so it is NEVER skipped. Cross-PAGE continuations into a left-column top are
            # owned by the cross-page detector, not invented here.
            if col_idx > 0 and page.height and sy0 < 0.14 * float(page.height):
                prev_bottom = blk_bot
                continue
            # marker box anchored at the COLUMN LEFT MARGIN (where a number would sit), at the stem's first
            # line — numberless (num=None); the sequence reconciler/gap-fill assigns a value when it can.
            out.append(Marker(num=None, x0=float(col.left), y0=sy0,
                              x1=float(col.left) + mh, y1=sy1, punct="struct"))
            prev_bottom = blk_bot
    return out
