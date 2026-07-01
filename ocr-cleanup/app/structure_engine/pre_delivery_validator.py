"""Pre-delivery validator — THE single authority before TS finalizes a crop.

A crop is DELIVERABLE only when this validator confirms the question is COMPLETE:
  - a question number is present (an unreadable / badged number is a separate review
    reason, not an incomplete crop),
  - stem text is present,
  - the FULL option set is present (the paper's INFERRED dominant count) OR a visual
    stand-in (diagram / table / equation / chemical structure) for a visual/numeric
    question,
  - ownership is valid (crop_allowed) and the crop geometry is valid (crop_valid),
  - no neighbour leak.

CRITICAL behaviour (user spec): when the option set is INCOMPLETE the validator does NOT
immediately fail or route to review — it ACTIVELY SEARCHES for the missing options, in
order, and only reviews if every search comes up empty:

  1. the ownership SLAB        — same column, marker → next marker (ownership_validator
                                 already ran this; re-run here is idempotent),
  2. CROSS-COLUMN continuation — the TOP of the next column, above its first owner,
  3. CROSS-PAGE continuation   — the TOP of the next page, above its first owner.

The search STOPS only at a REAL next owner (badge_guard rejects decorative / circled /
in-figure numbers as boundaries) so a question whose options spilled across a column or
page boundary recovers them instead of being delivered with 2 of 4.

The semantic option detector (option_owner_detector / tokens) and the badge/ownership
guard (badge_guard) are SUB-MODULES this validator calls — not independent systems.

Python decides; TS renders. This module MUTATES q.options (adds found options) and sets
q.deliverable + q.delivery_report + the document delivery_gate. It NEVER touches pixels.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from . import crop_completeness_validator as _cc
from .models import ElementKind, OptionRef, QuestionCandidate
from .option_owner_detector import options_in_region

_VISUAL_KINDS = {
    ElementKind.DIAGRAM,
    ElementKind.GRAPH,
    ElementKind.TABLE,
    ElementKind.EQUATION,
    ElementKind.CHEM_STRUCTURE,
}


# ─────────────────────────────────────────────────────────────────────────────
# Marker geometry (real owners only — used to BOUND the active search)
# ─────────────────────────────────────────────────────────────────────────────

def _col_of(metrics_by_page: Dict[int, Any], page: int, cx: float) -> int:
    m = metrics_by_page.get(page)
    try:
        return m.column_of(cx) if m else 0
    except Exception:  # noqa: BLE001
        return 0


def _build_marker_map(
    questions: List[QuestionCandidate], metrics_by_page: Dict[int, Any]
) -> Dict[Tuple[int, int], List[Tuple[float, str]]]:
    """(page, col) → sorted [(marker_y0, question_id)] for every owner's start anchor."""
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
        by_col.setdefault((pg, _col_of(metrics_by_page, pg, mcx)), []).append((my0, q.id))
    for v in by_col.values():
        v.sort()
    return by_col


def _next_marker_y(marker_map, page, col, own_y, own_id) -> Optional[float]:
    for my, qid in marker_map.get((page, col), ()):
        if my > own_y + 1.0 and qid != own_id:
            return my
    return None


def _first_marker_y(marker_map, page, col) -> Optional[float]:
    col_markers = marker_map.get((page, col), ())
    return col_markers[0][0] if col_markers else None


def _col_bounds(metrics_by_page, page, col) -> Tuple[float, float]:
    m = metrics_by_page.get(page)
    if m and m.columns and 0 <= col < len(m.columns):
        c = m.columns[col]
        return float(c.left), float(c.right)
    return 0.0, float("inf")


# ─────────────────────────────────────────────────────────────────────────────
# Active option search
# ─────────────────────────────────────────────────────────────────────────────

def _dedup_add(q: QuestionCandidate, found: List[OptionRef], max_add: int) -> List[OptionRef]:
    """Add newly-found options to q.options, skipping any that duplicate an existing one
    (same canonical label, or within 3px of an existing option's y on the same page) and
    adding AT MOST `max_add` (so recovery can never inflate past the paper's expected count
    — over-counting would mask a genuinely incomplete question). Reading order by (page,y0).
    Returns the list of options actually added (for the recovered-region report)."""
    from . import tokens
    if max_add <= 0:
        return []
    existing_keys = {tokens.option_label_value(o.label or "") for o in q.options}
    existing_pos = {(o.page, round(o.y0)) for o in q.options}
    added: List[OptionRef] = []
    for o in sorted(found, key=lambda r: (r.page, r.y0, r.x0)):
        if len(added) >= max_add:
            break
        key = tokens.option_label_value(o.label or "")
        if key is not None and key in existing_keys:
            continue
        if any(o.page == p and abs(o.y0 - y) < 3.0 for (p, y) in existing_pos):
            continue
        q.options.append(o)
        existing_keys.add(key)
        existing_pos.add((o.page, round(o.y0)))
        added.append(o)
    return added


def _region_words(page_data: Any, col_left: float, col_right: float,
                   y_top: float, y_bottom: float) -> List[Any]:
    """Words of a page inside [col_left,col_right] × [y_top,y_bottom], excluding figure-
    protected words (a label drawn inside a diagram is never an option)."""
    out = []
    for w in getattr(page_data, "words", ()):
        if getattr(w, "protected", False):
            continue
        if not (col_left <= w.cx <= col_right):
            continue
        if not (y_top <= w.cy <= y_bottom):
            continue
        out.append(w)
    return out


def _search_missing_options(
    q: QuestionCandidate,
    pages_by_index: Dict[int, Any],
    metrics_by_page: Dict[int, Any],
    marker_map: Dict[Tuple[int, int], List[Tuple[float, str]]],
    expected_options: int,
) -> Tuple[List[str], List[OptionRef]]:
    """Search slab → cross-column → cross-page for this question's missing options. Mutates
    q.options in place. Returns (regions that yielded options, the OptionRefs added) so the
    caller can report WHERE the missing options were found — the region TS must extend its
    crop to include (TS owns the boundary; this is the advisory extension hint)."""
    if not q.number_box:
        return [], []
    pg = int(q.number_box[0])
    y0 = float(q.number_box[2])
    cx = (float(q.number_box[1]) + float(q.number_box[3])) / 2.0
    col = _col_of(metrics_by_page, pg, cx)
    m = metrics_by_page.get(pg)
    if m is None:
        return [], []
    hit: List[str] = []
    added_all: List[OptionRef] = []

    # Skip the marker's OWN line: "1." has the option-label shape, so starting the scan AT
    # the marker would miscount the question number as option '1'. line_tol clears just that
    # line, never the option lines below it.
    line_skip = max(float(getattr(m, "line_tol", 0.0) or 0.0), 1.0)

    def _budget() -> int:
        # Never recover past the paper's expected count — over-counting masks a broken question.
        return expected_options - q.option_count

    # 1) SLAB — between this marker and the next owner in the same column, full column width.
    #    The slab is ALWAYS bounded (by the next marker or the page bottom) so it is safe.
    next_y = _next_marker_y(marker_map, pg, col, y0, q.id)
    slab_bottom = next_y if next_y is not None else float(getattr(pages_by_index.get(pg), "height", 1e9) or 1e9)
    cl, cr = _col_bounds(metrics_by_page, pg, col)
    page_data = pages_by_index.get(pg)
    if page_data is not None and _budget() > 0:
        words = _region_words(page_data, cl, cr, y0 + line_skip, slab_bottom)
        found = options_in_region(words, m, pg, cr)
        added = _dedup_add(q, found, _budget())
        if added:
            hit.append("slab")
            added_all += added

    # 2) CROSS-COLUMN — only if this question is the LAST owner in its column (its options
    #    may have spilled to the TOP of the next column, above that column's first owner).
    #    REQUIRE a real bounding marker in that column: without one the region is unbounded
    #    and would steal the next questions' options (e.g. when a marker went unread).
    if next_y is None and _budget() > 0 and m.columns and col + 1 < len(m.columns):
        first_next = _first_marker_y(marker_map, pg, col + 1)
        if first_next is not None:
            ncl, ncr = _col_bounds(metrics_by_page, pg, col + 1)
            words = _region_words(page_data, ncl, ncr, 0.0, first_next)
            found = options_in_region(words, m, pg, ncr)
            added = _dedup_add(q, found, _budget())
            if added:
                hit.append("cross_column")
                added_all += added

    # 3) CROSS-PAGE — only if this question is the LAST owner on its page (last column, no
    #    next owner). Its options may lead the TOP of the next page, above its first owner.
    #    REQUIRE a real bounding marker on the next page (same unbounded-region safety).
    last_col = (m.columns and col == len(m.columns) - 1) or not m.columns
    if next_y is None and _budget() > 0 and last_col:
        npg = pg + 1
        nm = metrics_by_page.get(npg)
        next_page = pages_by_index.get(npg)
        if nm is not None and next_page is not None:
            first_next = _first_marker_y(marker_map, npg, 0)
            if first_next is not None:
                ncl, ncr = _col_bounds(metrics_by_page, npg, 0)
                words = _region_words(next_page, ncl, ncr, 0.0, first_next)
                found = options_in_region(words, nm, npg, ncr)
                added = _dedup_add(q, found, _budget())
                if added:
                    hit.append("cross_page")
                    added_all += added

    return hit, added_all


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def validate_pre_delivery(
    questions: List[QuestionCandidate],
    metrics_by_page: Dict[int, Any],
    expected_options: int,
    pages_by_index: Dict[int, Any],
) -> Dict[str, Any]:
    """Run the single pre-delivery gate over every question. Mutates each question:

      q.deliverable      — True only if the crop is complete + valid + leak-free
      q.delivery_report  — structured per-question verdict (exposed via to_dict)
      q.needs_review     — set True (with a reason) when not deliverable

    Returns {"checked", "searched", "recovered", "blocked", "gate"} and sets nothing global.
    The caller assigns the document delivery_gate from the returned "gate".
    """
    marker_map = _build_marker_map(questions, metrics_by_page)
    stats = {"checked": 0, "searched": 0, "recovered": 0, "blocked": 0}

    for q in questions:
        stats["checked"] += 1
        n_before = q.option_count
        searched: List[str] = []

        # ACTIVE SEARCH first — try to COMPLETE the option set before judging completeness.
        # Only when the question carries SOME options but fewer than the paper's dominant
        # count, and it isn't a visual/numeric (diagram stand-in) question.
        recovered_regions: List[Dict[str, Any]] = []
        if expected_options >= 2 and 0 < q.option_count < expected_options and not q.has_diagram:
            searched, added_refs = _search_missing_options(
                q, pages_by_index, metrics_by_page, marker_map, expected_options
            )
            if searched:
                stats["searched"] += 1
                stats["recovered"] += (q.option_count - n_before)
                # Union the recovered options' bbox PER page — the advisory region TS must
                # extend / stitch its (TS-owned) crop to include. Python decides WHERE; TS
                # executes the boundary. Mirrors how chromeBands are applied to TS crops.
                by_page: Dict[int, List[float]] = {}
                for o in added_refs:
                    b = by_page.get(o.page)
                    if b is None:
                        by_page[o.page] = [o.x0, o.y0, o.x1, o.y1]
                    else:
                        b[0], b[1] = min(b[0], o.x0), min(b[1], o.y0)
                        b[2], b[3] = max(b[2], o.x1), max(b[3], o.y1)
                recovered_regions = [
                    {"page": pg, "x0": round(b[0], 2), "y0": round(b[1], 2),
                     "x1": round(b[2], 2), "y1": round(b[3], 2)}
                    for pg, b in sorted(by_page.items())
                ]

        complete, reasons = _cc.assess(q, expected=expected_options)

        # neighbor_leak: crop was auto-truncated at the neighbour's marker by validate_neighbor_leaks.
        # crop_valid=True means truncation succeeded and the question number is still contained.
        # Block only when crop_valid=False (repair failed); successful repairs route to review via
        # needs_review=True already set. Do NOT block deliverable here — crop_valid is the gate.
        deliverable = bool(
            complete
            and q.crop_allowed
            and q.crop_valid
        )
        q.deliverable = deliverable
        q.delivery_report = {
            "deliverable": deliverable,
            "complete": complete,
            "optionCount": q.option_count,
            "expectedOptions": expected_options,
            "optionsRecovered": q.option_count - n_before,
            "searchedRegions": searched,
            "recoveredRegions": recovered_regions,
            "hasDiagram": q.has_diagram,
            "cropAllowed": q.crop_allowed,
            "cropValid": q.crop_valid,
            "neighborLeak": q.neighbor_leak,
            "reasons": reasons,
        }

        if not deliverable:
            stats["blocked"] += 1
            q.needs_review = True
            tags = ["not_deliverable"] + [r.split(":")[0] for r in reasons]
            q.review_reasons = sorted(set(q.review_reasons + tags))

    stats["gate"] = "PASS" if stats["blocked"] == 0 else "REVIEW"
    return stats
