"""Ownership validation — the PRIMARY gate before crop construction.

ARCHITECTURE (the correct order):
  ownership graph → ownership freeze → [THIS MODULE] → crop construction → crop validation → neighbor leak

Every question must pass ownership validation before a crop is built. Questions with corrupt
ownership get crop_allowed=False, are skipped by plan_crops, and are flagged for review.
The neighbor_leak validator (post-crop) is the SAFETY NET; this module is the PRIMARY GATE.

7 dimensions validated per question:

  1. owner_pass         — question has a resolved number marker
  2. cross_page_pass    — cross-page questions have owned elements on both start and end pages
  3. cross_column_pass  — cross-column questions have at least 2 owned boxes
  4. protected_region_pass — owned DIAGRAM boxes are within contiguous range of question text
  5. option_pass        — expected option count met (0-option questions are exempt)
  6. solution_pass      — always True here; solution_owner.py handles it inside plan_crops
  7. next_question_safe — no TEXT element of this question starts past the next question's marker

FATAL dimensions (crop_allowed=False unless repair succeeds):
  - owner_pass=False        — no question number, crop has no identity
  - next_question_safe=False AND repair fails — corrupt ownership with no safe remainder

REPAIR:
  When next_question_safe=False, remove TEXT boxes and options that start past the next
  marker from q.boxes / q.options. Diagrams are KEPT (KEEP PIXELS). If the question
  still has owned boxes after repair, crop_allowed=True (repair succeeded, still flag review).
  If no boxes remain after repair, crop_allowed=False (nothing left to crop).

ADVISORY dimensions (review flag only, crop construction still allowed):
  - cross_page_pass=False
  - cross_column_pass=False
  - protected_region_pass=False
  - option_pass=False
  - solution_pass=False (always True currently)

Page boundaries and column boundaries are NEVER ownership separators. The owner changes
only when the next question's marker begins. Protected regions (diagrams, graphs, tables,
formulas) are ownership MEMBERS — KEEP PIXELS, KEEP LABELS, NO STRUCTURAL PROMOTION.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Set, Tuple

from . import tokens as _tokens
from .models import ElementKind, OptionRef, QuestionCandidate

_VISUAL_KINDS: Set[ElementKind] = {
    ElementKind.DIAGRAM,
    ElementKind.GRAPH,
    ElementKind.TABLE,
    ElementKind.EQUATION,
    ElementKind.CHEM_STRUCTURE,
}


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers (mirror _build_markers_by_col / _next_marker_top in crop_planner)
# ─────────────────────────────────────────────────────────────────────────────

def _col_of(metrics_by_page: Dict[int, Any], page: int, cx: float) -> int:
    m = metrics_by_page.get(page)
    try:
        return m.column_of(cx) if m else 0
    except Exception:
        return 0


def _mh_for(metrics_by_page: Dict[int, Any], page: int) -> float:
    m = metrics_by_page.get(page)
    return (getattr(m, "median_h", 0) or 18.0) if m else 18.0


def _build_marker_map(
    questions: List[QuestionCandidate],
    metrics_by_page: Dict[int, Any],
) -> Dict[Tuple[int, int], List[Tuple[float, str]]]:
    """Build (page, col) → sorted [(marker_y0, question_id)] for every question's start anchor."""
    by_col: Dict[Tuple[int, int], List[Tuple[float, str]]] = {}
    for q in questions:
        if q.number_box:
            pg = int(q.number_box[0])
            my0 = float(q.number_box[2])
            mcx = (float(q.number_box[1]) + float(q.number_box[3])) / 2.0
        elif q.boxes:
            b = min(q.boxes, key=lambda bb: bb.y0)
            pg, my0, mcx = b.page, float(b.y0), (b.x0 + b.x1) / 2.0
        else:
            continue
        col = _col_of(metrics_by_page, pg, mcx)
        by_col.setdefault((pg, col), []).append((my0, q.id))
    for v in by_col.values():
        v.sort()
    return by_col


def _next_marker_y(
    marker_map: Dict[Tuple[int, int], List[Tuple[float, str]]],
    page: int,
    col: int,
    own_y: float,
    own_id: str,
) -> Optional[float]:
    """Y of the next different question's marker below `own_y` in this (page, col), or None."""
    for my, qid in marker_map.get((page, col), ()):
        if my > own_y + 1.0 and qid != own_id:
            return my
    return None


def _anchor(q: QuestionCandidate) -> Tuple[int, float, float]:
    """Return (page, marker_y0, marker_cx) for q's start position."""
    if q.number_box:
        return (
            int(q.number_box[0]),
            float(q.number_box[2]),
            (float(q.number_box[1]) + float(q.number_box[3])) / 2.0,
        )
    if q.boxes:
        b = min(q.boxes, key=lambda bb: bb.y0)
        return b.page, float(b.y0), (b.x0 + b.x1) / 2.0
    return q.start_page, 0.0, 0.0


# ─────────────────────────────────────────────────────────────────────────────
# Option slab scan — repair missing options before the primary gate decides
# ─────────────────────────────────────────────────────────────────────────────

def _scan_slab_options(
    q: QuestionCandidate,
    pages_by_index: Dict[int, Any],
    metrics_by_page: Dict[int, Any],
    marker_map: Dict[Tuple[int, int], List[Tuple[float, str]]],
) -> None:
    """Search the ownership slab (number_box.y0 → next marker, full column width) for option
    label tokens that the ownership graph missed and add them to q.options.

    This is a REPAIR step: when the option detector under-counted (e.g. a garbled "(a)"→"@"),
    the slab is the authoritative boundary — everything between the question's marker and the
    next question's marker belongs to it. Protected words (inside figures) are never promoted.

    Mutates q.options in place. Never removes existing options. Never raises.
    """
    if not q.number_box:
        return
    try:
        pg = int(q.number_box[0])
        y0_anch = float(q.number_box[2])
        cx_anch = (float(q.number_box[1]) + float(q.number_box[3])) / 2.0
        col = _col_of(metrics_by_page, pg, cx_anch)
        next_y = _next_marker_y(marker_map, pg, col, y0_anch, q.id)
        y_bottom = next_y if next_y is not None else float("inf")

        m = metrics_by_page.get(pg)
        colg = m.columns[col] if (m and m.columns and 0 <= col < len(m.columns)) else None
        x_left = float(colg.left) if colg else 0.0
        x_right = float(colg.right) if colg else float("inf")

        page_data = pages_by_index.get(pg)
        if page_data is None:
            return

        # Positions of already-owned options — dedup by y0 proximity (within 3 px).
        existing_y: List[float] = [float(o.y0) for o in q.options]

        for w in page_data.words:
            if w.protected:
                continue
            if not (y0_anch <= w.cy <= y_bottom):
                continue
            if not (x_left <= w.cx <= x_right):
                continue
            if not _tokens.is_option_label(w.text):
                continue
            if any(abs(w.y0 - ey) < 3.0 for ey in existing_y):
                continue  # already owned at this position
            q.options.append(OptionRef(
                label=w.text.strip(),
                page=pg,
                x0=w.x0, y0=w.y0, x1=w.x1, y1=w.y1,
            ))
            existing_y.append(float(w.y0))
    except Exception:  # noqa: BLE001 — repair is best-effort; never break validation
        pass


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def validate_ownership(
    questions: List[QuestionCandidate],
    metrics_by_page: Dict[int, Any],
    expected_options: int,
    pages_by_index: Optional[Dict[int, Any]] = None,
) -> Dict[str, int]:
    """Validate ownership for each question in place (mutates questions).

    Sets per question:
      q.crop_allowed     — False if ownership is fatally corrupt and unrecoverable
      q.ownership_report — 7-dimension PASS/FAIL dict (exposed to TS via to_dict)
      q.needs_review     — True if ANY dimension failed (advisory or fatal)
      q.review_reasons   — list of short failure tags (appended, never clobbered)

    Returns stats dict: {"checked": N, "blocked": N, "repaired": N}
    """
    marker_map = _build_marker_map(questions, metrics_by_page)
    stats: Dict[str, int] = {"checked": 0, "blocked": 0, "repaired": 0}

    for q in questions:
        stats["checked"] += 1
        failures: List[str] = []

        # ── 1. OWNER ────────────────────────────────────────────────────────
        owner_pass = q.number is not None
        if not owner_pass:
            failures.append("owner:no_number")

        # ── 2. CROSS-PAGE ────────────────────────────────────────────────────
        cross_page_pass = True
        if q.multi_page:
            pages_seen = {b.page for b in q.boxes}
            if q.start_page not in pages_seen or q.end_page not in pages_seen:
                cross_page_pass = False
                failures.append("cross_page:incomplete_span")

        # ── 3. CROSS-COLUMN ──────────────────────────────────────────────────
        cross_column_pass = True
        if q.multi_column and len(q.boxes) < 2:
            cross_column_pass = False
            failures.append("cross_column:single_box")

        # ── 4. PROTECTED REGION ──────────────────────────────────────────────
        # An owned DIAGRAM box that sits more than 3 line-heights below the question's
        # last TEXT box is a sign that assign_figures_to_questions absorbed the wrong figure.
        protected_region_pass = True
        if q.has_diagram:
            pg_anch, _, _ = _anchor(q)
            mh = _mh_for(metrics_by_page, pg_anch)
            text_ys = [b.y1 for b in q.boxes if b.kind not in _VISUAL_KINDS and b.page == pg_anch]
            diag_y0s = [b.y0 for b in q.boxes if b.kind in _VISUAL_KINDS and b.page == pg_anch]
            if text_ys and diag_y0s:
                text_bottom = max(text_ys)
                diag_top = min(diag_y0s)
                if diag_top > text_bottom + 3.0 * mh:
                    protected_region_pass = False
                    failures.append(f"protected_region:gap_{round(diag_top - text_bottom, 1)}px")

        # ── 5. OPTIONS ───────────────────────────────────────────────────────
        # Only fail if the question HAS options but fewer than expected. Zero-option
        # questions are visual/numeric — they are not an option failure.
        option_pass = True
        if expected_options >= 2 and q.option_count < expected_options:
            # SLAB REPAIR: scan the question's full slab for option labels the ownership graph
            # missed (garbled "(a)"→"@", protected-region false positive, cross-column miss).
            # Adds missing OptionRefs to q.options BEFORE the pass/fail decision — repair first.
            if pages_by_index is not None:
                _scan_slab_options(q, pages_by_index, metrics_by_page, marker_map)
            if 0 < q.option_count < expected_options:
                option_pass = False
                failures.append(f"option:{q.option_count}_of_{expected_options}")
            # q.option_count == 0 → VISUAL/NUMERIC question, not an option failure

        # ── 6. SOLUTION ──────────────────────────────────────────────────────
        # solution_owner.py runs inside plan_crops — always True at this stage.
        solution_pass = True

        # ── 7. NEXT QUESTION SAFE ────────────────────────────────────────────
        # A TEXT element that STARTS past the next question's marker means the ownership
        # graph included content from the next question. Diagrams are KEPT (KEEP PIXELS).
        # REPAIR: remove overflowing TEXT boxes / options from q.boxes / q.options.
        next_question_safe = True
        pg_anch, my0_anch, mcx_anch = _anchor(q)
        col = _col_of(metrics_by_page, pg_anch, mcx_anch)
        next_y = _next_marker_y(marker_map, pg_anch, col, my0_anch, q.id)

        if next_y is not None:
            mh = _mh_for(metrics_by_page, pg_anch)
            # An element "starts past" the boundary when its y0 exceeds next_y minus half
            # a line height (a grace band so a line that merely brushes the boundary isn't
            # flagged — the crop planner's slab_bottom handles that sub-pixel case).
            boundary = next_y - 0.5 * mh

            overflow_boxes = [
                b for b in q.boxes
                if b.page == pg_anch
                and b.kind not in _VISUAL_KINDS
                and b.y0 > boundary
            ]
            overflow_opts = [
                o for o in q.options
                if o.page == pg_anch and o.y0 > boundary
            ]

            if overflow_boxes or overflow_opts:
                next_question_safe = False
                tag = (
                    f"next_q_safe:overflow_{len(overflow_boxes)}box"
                    f"+{len(overflow_opts)}opt@y>{round(next_y, 1)}"
                )
                # REPAIR — remove overflowing elements; diagrams are never removed
                if overflow_boxes:
                    q.boxes = [b for b in q.boxes if b not in overflow_boxes]
                if overflow_opts:
                    q.options = [o for o in q.options if o not in overflow_opts]
                stats["repaired"] += 1

                if q.boxes:
                    # Repair succeeded — enough owned content remains to build a valid crop
                    next_question_safe = True
                    failures.append(tag + ":repaired")
                else:
                    failures.append(tag + ":unrecoverable")

        # ── CROSS-PAGE INTEGRITY ──────────────────────────────────────────────
        # Validator 2 (first-question protection) in cross_page_detector.py is the PRIMARY
        # guard against false cross-page absorption (Q16 pattern). If it works correctly,
        # Q16 will NOT be multi_page=True by the time we reach here. If it fires, Q7 keeps
        # multi_page=True (legitimate). This validator only REPORTS the firstOnPage field —
        # it does NOT flag first-on-page+multi-page as a warning (that would incorrectly
        # mark Q7 for review). The detection layer owns prevention; this layer owns reporting.
        first_on_page = getattr(q, 'first_on_page', False)

        # ── OVERALL ──────────────────────────────────────────────────────────
        crop_allowed = owner_pass and next_question_safe
        q.crop_allowed = crop_allowed
        q.ownership_report = {
            "ownerPass": owner_pass,
            "crossPagePass": cross_page_pass,
            "crossColumnPass": cross_column_pass,
            "protectedRegionPass": protected_region_pass,
            "optionPass": option_pass,
            "solutionPass": solution_pass,
            "nextQuestionSafe": next_question_safe,
            "firstOnPage": first_on_page,
            "cropAllowed": crop_allowed,
            "failureReasons": failures,
        }

        if not crop_allowed:
            stats["blocked"] += 1

        if failures:
            q.needs_review = True
            new_tags = sorted(set(q.review_reasons + [r.split(":")[0] for r in failures]))
            q.review_reasons = new_tags

    return stats
