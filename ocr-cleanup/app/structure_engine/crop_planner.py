"""Crop planner — Python OWNS every crop boundary; TS only executes.

For each question the ownership graph produced, compute the EXACT crop rectangle(s) TS must cut — one
per page the question touches — as the union of everything the question owns (number box + text/owned
boxes + option refs + visual regions), clipped to that page's repeated-chrome band (so an institute
header/footer never enters a crop), padded engine-side, and clamped to the page bounds. The result is
emitted as `question.crop_regions` in the SAME coordinate space as the OCR word boxes TS sent (the page
render's pixel space), so TS crops them verbatim with no geometry of its own.

Also records `visual_regions` (the owned figure/graph/table/equation/chem boxes), a `crop_valid` flag
(boundary inside the page, number box contained, not chrome-truncated to nothing), and the inferred
`question_type`. Pure geometry; no PDF/institute constants; never raises.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

from . import solution_owner
from .models import ElementKind, PageInput, QuestionCandidate

_VISUAL_KINDS = {
    ElementKind.DIAGRAM,
    ElementKind.GRAPH,
    ElementKind.TABLE,
    ElementKind.EQUATION,
    ElementKind.CHEM_STRUCTURE,
}

_PAD_FRAC = 0.04   # 4% safety margin so a crop never hugs content (mirror of the old TS padding)
_PAD_MIN = 6.0


def _infer_type(q: QuestionCandidate, expected_options: int) -> str:
    """Question type from structure only (no keywords/PDF specifics). Conservative: emit what geometry
    supports — a clear option set ⇒ SINGLE_CHOICE, no options ⇒ NUMERIC (or VISUAL when a figure
    dominates). MULTI / ASSERTION_REASON need textual cues we don't reliably have, so we don't guess."""
    n = q.option_count
    has_visual = bool(q.has_diagram) or any(v == "PASS" for v in q.visuals.values())
    if n >= 2:
        return "SINGLE_CHOICE"
    if has_visual:
        return "VISUAL"
    return "NUMERIC"


def _col_of(metrics_by_page: Dict[int, Any], page: int, cx: float) -> int:
    m = metrics_by_page.get(page)
    try:
        return m.column_of(cx) if m else 0
    except Exception:  # noqa: BLE001
        return 0


def _build_markers_by_col(
    questions: List[QuestionCandidate], metrics_by_page: Dict[int, Any]
) -> Dict[Tuple[int, int], List[Tuple[float, str]]]:
    """Per (page, column): sorted (marker_top_y, question_id) for every question's START anchor — its
    number box, or its top-most box when the number was unread/badged. The crop planner uses this to
    bound each crop at the NEXT question's marker, so content the per-element ownership missed (garbled
    option labels like "(a)"→"@", stem continuations) is still captured and no crop bleeds into the next
    question."""
    by_col: Dict[Tuple[int, int], List[Tuple[float, str]]] = {}
    for q in questions:
        if q.number_box:
            pg = int(q.number_box[0])
            my0 = float(q.number_box[2])
            mcx = (q.number_box[1] + q.number_box[3]) / 2.0
        elif q.boxes:
            b = min(q.boxes, key=lambda bb: bb.y0)
            pg, my0, mcx = b.page, float(b.y0), (b.x0 + b.x1) / 2.0
        else:
            continue
        by_col.setdefault((pg, _col_of(metrics_by_page, pg, mcx)), []).append((my0, q.id))
    for v in by_col.values():
        v.sort()
    return by_col


def _next_marker_top(
    by_col: Dict[Tuple[int, int], List[Tuple[float, str]]],
    page: int,
    col: int,
    group_top: float,
    self_id: str,
) -> float | None:
    """Top-y of the next DIFFERENT question's marker in this column below `group_top`, or None (last in
    the column)."""
    for my, qid in by_col.get((page, col), ()):  # pre-sorted ascending
        if my > group_top + 1.0 and qid != self_id:
            return my
    return None


def plan_crops(
    questions: List[QuestionCandidate],
    pages_by_index: Dict[int, PageInput],
    bands: Dict[int, Tuple[float, float]],
    expected_options: int,
    metrics_by_page: Dict[int, Any] | None = None,
    frame_x_by_page: Dict[int, Tuple[Any, Any]] | None = None,
) -> None:
    """Populate crop_regions / visual_regions / crop_valid / question_type on each question in place.
    `frame_x_by_page` maps a page index to the (left_x, right_x) of THAT page's FRAME vertical rule lines
    (or Nones) — crops are clamped to just INSIDE them so the frame never enters a crop, WITHOUT clipping
    content (the frame sits in the page margin, far outside every column). Per-page so a multi-resolution
    document (concatenated papers) clamps each page to its own frame, never another paper's."""
    metrics_by_page = metrics_by_page or {}
    frame_x_by_page = frame_x_by_page or {}
    markers_by_col = _build_markers_by_col(questions, metrics_by_page)
    for q in questions:
        if not getattr(q, "crop_allowed", True):
            # Ownership validator blocked this question — no crop built; already flagged for review
            q.crop_regions = []
            q.crop_valid = False
            continue
        try:
            _plan_one(q, pages_by_index, bands, expected_options, metrics_by_page, markers_by_col,
                      frame_x_by_page)
        except Exception:  # noqa: BLE001 — a single odd question never fails the document
            q.crop_regions = []
            q.crop_valid = False


# A tagged owned rectangle: (x0, y0, x1, y1, is_option, is_visual).
_Elem = Tuple[float, float, float, float, bool, bool]

_OPT_LEADIN = ("choose the correct", "in the light of the above", "from the options given",
               "options given below", "correct answer from")


def _match_table_real_options_cap(page_obj, col, cap, lower, line_tol):
    """LAYER 2 (evidence-gated) — Match-the-Following / Assertion-Reason: a question's DETECTED options can be
    the match TABLE's own internal labels (A,B,C,D / I,II,III,IV), which makes the crop cap stop at the table.
    If — and ONLY if — the REAL answer block sits BELOW that cap within this question's slab, recognised by an
    options LEAD-IN ("choose the correct answer…", "in the light of the above statements…") followed by >=3
    option-family labels ((a),(b),(c),(d) / (1)-(4)…), return the bottom y of that real block so the crop can
    extend to it. Returns None — crop unchanged — for every other question (a normal MCQ has no lead-in +
    option block below its cap), so the general crop path is byte-identical outside this exact evidence."""
    from .geometry import group_lines as _gl
    from . import tokens as _tok
    words = [w for w in page_obj.words
             if (col.left - 0.5) <= ((w.x0 + w.x1) / 2.0) <= (col.right + 0.5)
             and not getattr(w, "chrome", False) and cap < w.y0 < lower]
    if not words:
        return None
    lead_seen = False
    labels = 0
    last_y = cap
    for ln in sorted(_gl(words, line_tol), key=lambda l: l.y0):
        ws = sorted(ln.words, key=lambda w: w.x0)
        if not ws:
            continue
        if not lead_seen:
            txt = " ".join(w.text for w in ws).lower()
            if any(c in txt for c in _OPT_LEADIN):
                lead_seen = True
            continue
        ln_labels = [w for w in ws if _tok.is_option_label(w.text)]
        if ln_labels:
            labels += len(ln_labels)
            last_y = ln.y1
    return last_y if (lead_seen and labels >= 3) else None


def _plan_one(
    q: QuestionCandidate,
    pages_by_index: Dict[int, PageInput],
    bands: Dict[int, Tuple[float, float]],
    expected_options: int,
    metrics_by_page: Dict[int, Any],
    markers_by_col: Dict[Tuple[int, int], List[Tuple[float, str]]],
    frame_x_by_page: Dict[int, Tuple[Any, Any]] | None = None,
) -> None:
    # Group every owned rectangle by (page, COLUMN). Column-aware grouping is what makes a CROSS-COLUMN
    # question (stem at the bottom of the left column, options at the top of the right column) emit one
    # region PER COLUMN — left stem + right options — that TS stitches in reading order, instead of a
    # single box spanning the gutter (which would swallow the neighbouring column's questions). The
    # column index comes from the page's detected column bounds (a 2-up option layout stays in ONE
    # column, so options are never split). A single-column question yields exactly one group/region.
    def _col(page: int, cx: float) -> int:
        m = metrics_by_page.get(page)
        try:
            return m.column_of(cx) if m else 0
        except Exception:  # noqa: BLE001
            return 0

    groups: Dict[Tuple[int, int], List[_Elem]] = {}
    for b in q.boxes:
        key = (b.page, _col(b.page, (b.x0 + b.x1) / 2.0))
        groups.setdefault(key, []).append((b.x0, b.y0, b.x1, b.y1, False, b.kind in _VISUAL_KINDS))
    for o in q.options:
        key = (o.page, _col(o.page, (o.x0 + o.x1) / 2.0))
        groups.setdefault(key, []).append((o.x0, o.y0, o.x1, o.y1, True, False))
    if q.number_box:
        pg = int(q.number_box[0])
        nx0, ny0, nx1, ny1 = q.number_box[1], q.number_box[2], q.number_box[3], q.number_box[4]
        groups.setdefault((pg, _col(pg, (nx0 + nx1) / 2.0)), []).append((nx0, ny0, nx1, ny1, False, False))

    full_opts = q.option_count >= max(2, expected_options)

    # SOLUTION BOUNDARY (question-level, ownership-driven). Find the (page, column, y) where THIS question's
    # OPTION block ends and a worked SOLUTION begins — recovered by POSITION so OCR-garbled math option
    # labels ('C) 1/2' -> 'CESS') don't defeat it, and confirmed only by multi-signal (explanation cue OR
    # formula density). Everything after it is the solution: the option page+column is capped at `sol_y`,
    # and any LATER-page region of THIS question (a cross-page solution tail, e.g. PHYCHE Q23) is DROPPED.
    # None => KEEP PIXELS. Only this owner's regions are ever affected — the next question is never touched.
    sol_page: Any = None
    sol_col: Any = None
    sol_y: Any = None
    try:
        opts_by_page: Dict[int, List[Tuple[float, float, float, float]]] = {}
        for o in q.options:
            opts_by_page.setdefault(int(o.page), []).append((o.x0, o.y0, o.x1, o.y1))
        # The page to anchor the solution scan on: the page carrying the option labels (MCQ) OR — for a
        # NUMERIC / VISUAL question with no options — the page carrying the question number / first content.
        if opts_by_page:
            op = max(opts_by_page)  # LAST page with options — the cross-page drop-gate must anchor
            # to the highest-page-number with options. Using max-by-count can return an EARLIER page
            # (e.g. page N when A/B are there and C/D are on page N+1 with equal counts) which causes
            # `if page > sol_page: continue` to DROP the cross-page crop region carrying C/D.
        elif q.number_box:
            op = int(q.number_box[0])
        elif q.boxes:
            op = int(min(q.boxes, key=lambda b: (b.page, b.y0)).page)
        else:
            op = None
        mo = metrics_by_page.get(op) if op is not None else None
        pgo = pages_by_index.get(op) if op is not None else None
        if op is not None and pgo is not None and mo is not None and mo.columns:
            oboxes = opts_by_page.get(op, [])
            if oboxes:
                anchor_cx = sum((b[0] + b[2]) / 2.0 for b in oboxes) / len(oboxes)
                ctop = min(b[1] for b in oboxes)
            elif q.number_box and int(q.number_box[0]) == op:
                anchor_cx = (q.number_box[1] + q.number_box[3]) / 2.0
                ctop = float(q.number_box[2])
            else:
                bs = [b for b in q.boxes if int(b.page) == op]
                anchor_cx = sum((b.x0 + b.x1) / 2.0 for b in bs) / len(bs)
                ctop = min(b.y0 for b in bs)
            oc = _col(op, anchor_cx)
            colg = mo.columns[oc] if 0 <= oc < len(mo.columns) else mo.columns[0]
            next_marker = _next_marker_top(markers_by_col, op, oc, ctop, q.id)  # bound: never read N+1
            # owned VISUALS (diagram/table/formula/chem) on this page+column — the solution layer extends the
            # crop boundary THROUGH them so a question diagram is KEPT (protected region), never cut.
            owned_vis = [
                (b.x0, b.y0, b.x1, b.y1)
                for b in q.boxes
                if int(b.page) == op and b.kind in _VISUAL_KINDS and _col(op, (b.x0 + b.x1) / 2.0) == oc
            ]
            y = solution_owner.question_crop_end(
                oboxes, pgo.words, mo, colg.left, colg.right,
                region_bottom=next_marker, owned_visuals=owned_vis, content_top=ctop,
            )
            if y is not None:
                sol_page, sol_col, sol_y = op, oc, y
    except Exception:  # noqa: BLE001 — solution trim is best-effort; never break a crop
        sol_page = sol_col = sol_y = None

    regions: List[Dict[str, Any]] = []
    for (page, _coli) in sorted(groups):
        # DROP a later-page region of this question once its option block ended on an earlier page (the
        # region is a cross-page SOLUTION tail, never question content).
        if sol_page is not None and page > sol_page:
            continue
        elems = groups[(page, _coli)]
        m = metrics_by_page.get(page)
        mh = m.median_h if (m and getattr(m, "median_h", 0)) else 18.0
        # SOLUTION / EXPLANATION TRIM (structural, keyword-free), scoped to THIS column: a complete MCQ
        # ends at its option block, so cap this column's crop bottom at its last OPTION or owned VISUAL;
        # text below it in the SAME column (the "SOL:"/"correct answer is …") is dropped. Column-scoped
        # so a cross-column stem (which sits lower in absolute y, in a DIFFERENT column) is never dropped.
        # Skipped for a descriptive/numeric question (no full option set), whose working below is content.
        cap = None
        if full_opts:
            ov = [e[3] for e in elems if e[4] or e[5]]
            if ov:
                cap = max(ov)
                # EXTEND the cap through boxes CONTIGUOUS below the last option — a WRAPPED 2-line option's
                # second line is a non-option box that starts ~1 line under the option ref; capping at the
                # option ref alone dropped it (the "option (d) cut off at bottom" bug). A real solution
                # block sits below a CLEAR gap (> ~1.6 line-heights), so it is still excluded.
                line_gap = 0.5 * mh
                extended = True
                while extended:
                    extended = False
                    for e in elems:
                        # only a NON-visual box (a wrapped option line) that STARTS within ~half a line of
                        # the running cap — a diagram is already in `cap`, and a solution starts after a
                        # bigger paragraph gap, so neither is swept in.
                        if (not e[5]) and e[3] > cap and cap < e[1] <= cap + line_gap:
                            cap = e[3]
                            extended = True
        # OWNERSHIP-DRIVEN SOLUTION TRIM (question-level boundary computed above) — cap the OPTION page+column
        # at the option-block bottom even when the full_opts cap could not fire (math option labels garbled).
        if sol_y is not None and page == sol_page and _coli == sol_col:
            cap = sol_y if cap is None else min(cap, sol_y)
        # LAYER 2 (Match-the-Following / Assertion-Reason): the cap above may sit at the match-TABLE's internal
        # labels (A,B,C,D / I,II,III,IV) mistaken for the answer options, which drops the REAL option block
        # below. When that exact evidence exists — a lead-in + >=3 option labels below the cap, within this
        # question's own slab — extend the cap to the real options so they are kept. No-op for every other
        # question (a normal MCQ has no lead-in + option block below its cap), so the crop path is unchanged.
        if cap is not None and full_opts:
            _pg2 = pages_by_index.get(page)
            _mm2 = metrics_by_page.get(page)
            if _pg2 and _mm2 and 0 <= _coli < len(_mm2.columns):
                _lower2 = _next_marker_top(markers_by_col, page, _coli, cap, q.id)
                if _lower2 is None:
                    _lower2 = float(_pg2.height)
                _rc2 = _match_table_real_options_cap(_pg2, _mm2.columns[_coli], cap, _lower2, _mm2.line_tol)
                if _rc2 is not None and _rc2 > cap:
                    cap = _rc2
        rects: List[_Elem] = elems
        if cap is not None:
            kept = [e for e in elems if e[1] <= cap + 2.0]
            if kept:
                rects = kept
        # HORIZONTAL extent = the WHOLE COLUMN (TS parity), not the owned-rects bbox. The ownership graph
        # can UNDER-capture a stem's width (a missed trailing word) so max(owned r.x1) falls short and the
        # stem is right-CLIPPED ("…acceleratio[n]", a half-cut option). TS's buildRegions uses the column's
        # own left/right and therefore never clips. So take x from the DETECTED COLUMN geometry; keep the
        # owned rects only for the VERTICAL span + column assignment. Fallback to the owned bbox when this
        # group has no column metrics. (frame-x clamp + page-bound clamp below still keep x inside the page.)
        if m and m.columns and 0 <= _coli < len(m.columns):
            x0 = float(m.columns[_coli].left)
            x1 = float(m.columns[_coli].right)
        else:
            x0 = min(r[0] for r in rects)
            x1 = max(r[2] for r in rects)
        y0 = min(r[1] for r in rects)
        y1 = max(r[3] for r in rects)
        # CROSS-COLUMN Y0 ANCHOR: for multi-column questions the number marker is in col 0 but
        # col 1 content (options, continuation stem, diagram) starts at the SAME Y line as the marker.
        # Without this, col 1's y0 = first owned element (e.g. a diagram at y=200) and the question
        # text above it at y=100 is invisible in the crop — "diagram only" or "half question."
        # Guard: q.multi_column=False for genuine 2-col papers (each column has independent questions),
        # so this anchor never fires for AD/AIOTS-style layouts.
        if q.number_box and q.multi_column and page == int(q.number_box[0]):
            y0 = min(y0, float(q.number_box[2]))
        # SLAB BOUND — set the crop bottom to just above the NEXT question's marker in THIS column.
        # Everything between a question's marker and the next belongs to it, so options / stem
        # continuations that per-element ownership missed (OCR-garbled "(a)"→"@", so optionCount=0 and
        # the raw bbox stopped at the stem) are still captured; and a stray attached box can no longer
        # bleed the crop into the following question. The last question in a column keeps its owned
        # bottom (slab is None ⇒ no change). A column with detected gutter makes this per-COLUMN, so a
        # cross-column question's options group is bounded by the next marker in the OPTIONS' column.
        content_top = y0  # this question's OWN top (its number / first element)
        slab = _next_marker_top(markers_by_col, page, _coli, y0, q.id)
        slab_bottom = None
        if slab is not None:
            slab_bottom = slab - 0.6 * mh  # a clear gap so the NEXT question's first line is excluded
            y1 = max(y0 + 4.0, slab_bottom)
        else:
            # LAST QUESTION IN COLUMN: no next marker — y1 = max(owned elements) which stops at the
            # last detected option/box and misses any undetected options below it. Extend to the page
            # bottom so all remaining content is captured; the chrome band (footer_top) clips the safe
            # maximum. A complete MCQ's solution trim cap (below) still prevents solution bleed.
            _pdata = pages_by_index.get(page)
            if _pdata and _pdata.height > y1:
                y1 = float(_pdata.height)
        if cap is not None:
            y1 = min(y1, cap)  # a COMPLETE MCQ still stops at its last option (excludes the solution)
        # clip to the repeated header/footer band so chrome never enters the crop. This clipping is
        # DESIRED (the band is repeated institute chrome, never question content) — it never makes a
        # crop invalid; only a genuinely degenerate region (below) is dropped.
        band = bands.get(page)
        # SINGLE-COLUMN HEADER-BAND OVER-CLIP GUARD (the multi-column path is untouched). The repeated-header
        # band over-extends on some pages (Biology page 11 → header_bottom=315) and the normal clip then eats
        # real content that sits near the page top: a CROSS-PAGE continuation's spilled A,B row (Q20/41/46),
        # OR the FIRST question on the page whose number+stem start inside the over-extended band (Q60 → only
        # the C,D row survived). On a SINGLE-COLUMN page, the effective header bottom is pulled UP so it never
        # crosses this region's own first NON-CHROME content line: the institute header/banner (chrome-tagged,
        # or an image above the content) is still removed, but the wrongly-clipped stem/options are kept. The
        # clamp only ever LOWERS the header band (min), so a page whose band is already correct is unchanged.
        _m_pg = metrics_by_page.get(page)
        _keep_top = bool(_m_pg) and len(_m_pg.columns) <= 1
        _eff_header = band[0] if band else 0.0
        if _keep_top and band and band[0] > 0:
            _pgw = pages_by_index.get(page)
            _nc = [w.y0 for w in (_pgw.words if _pgw else [])
                   if not getattr(w, "chrome", False) and (x0 - 2) <= ((w.x0 + w.x1) / 2.0) <= (x1 + 2)
                   and (y0 - 0.5 * mh) <= w.y0 < y1]
            if _nc:
                _eff_header = min(band[0], min(_nc) - 0.3 * mh)
        if band:
            header_bottom, footer_top = _eff_header, band[1]
            if header_bottom > 0 and y0 < header_bottom:
                y0 = header_bottom
            if footer_top > 0 and y1 > footer_top:
                y1 = footer_top
        # engine-side padding
        pad_x = max(_PAD_MIN, (x1 - x0) * _PAD_FRAC)
        pad_y = max(_PAD_MIN, (y1 - y0) * _PAD_FRAC)
        x0, y0, x1, y1 = x0 - pad_x, y0 - pad_y, x1 + pad_x, y1 + pad_y
        # ANTI-BLEED — padding must NEVER cross into an adjacent question. Cap the top so it can't rise
        # past this question's own first element (into the PREVIOUS question's tail) and the bottom so it
        # can't drop past the NEXT question's marker. This removes the thin top/bottom slivers of the
        # neighbouring question the user sees in a crop.
        y0 = max(y0, content_top - 0.3 * mh)
        if slab_bottom is not None:
            y1 = min(y1, slab_bottom)
        # RE-APPLY the chrome band AFTER padding: padding (added above) had pushed y0/y1 back PAST the
        # header_bottom / footer_top the earlier clip set, re-introducing the institute header
        # ("…JUNIOR IAS") / footer ("MADURAI… PRIVATE EDUCATIONAL SERVICES"). A cross-column crop shows it
        # most (left-col footer + right-col header land between the two stitched parts). Clamp once more so
        # chrome can never sit inside a delivered crop.
        if band:
            header_bottom, footer_top = _eff_header, band[1]
            if header_bottom > 0:
                y0 = max(y0, header_bottom)
            if footer_top > 0:
                y1 = min(y1, footer_top)
        # FIGURE PROTECTION — extend crop to include owned visual boxes that protrude below the current
        # bottom or past the right edge. The y extension is intentionally bounded by slab_bottom (the
        # next question's marker) — a diagram that physically overlaps the next question is still cropped
        # at the ownership boundary. The x extension covers diagrams whose strokes exceed col.right
        # (e.g. col.right=258 but the circuit extends to x=700).
        for _vx0, _vy0, _vx1, _vy1 in [(e[0], e[1], e[2], e[3]) for e in elems if e[5]]:
            if _vy0 <= y1 + 0.5 * mh and _vy1 > y1:
                # Extend y only up to the OWNERSHIP BOUNDARY (the next question's marker). A figure
                # may physically extend below the marker but ownership stops there — we must NEVER
                # pull a neighbouring question's content into this crop.
                capped_vy1 = _vy1 if slab_bottom is None else min(_vy1, slab_bottom)
                y1 = capped_vy1
            if _vx1 > x1:
                x1 = _vx1  # diagram wider than the detected column (figure strokes outside the text extent)
        # OWNERSHIP FREEZE — re-enforce the next-question marker as a hard stop AFTER figure protection.
        # Figure protection may raise y1; if it exceeds slab_bottom the crop would absorb the next
        # question ("Q4 absorbs Q5"). The next marker is immutable: once detected, ownership is frozen.
        if slab_bottom is not None:
            y1 = min(y1, slab_bottom)
        if band and band[1] > 0:
            y1 = min(y1, band[1])
        # CLAMP X to just INSIDE the page-FRAME vertical rule lines — removes the drawn frame border that
        # padding had pushed the crop edge out onto. The frame sits in the page MARGIN, far outside every
        # column, so this NEVER clips content (unlike clamping to the tight column/gutter bound, which cut
        # the right edge of wide lines + sliced right-column seals into fragments). Frame unknown ⇒ skip.
        frame_x = (frame_x_by_page or {}).get(page)
        if frame_x:
            fl, fr = frame_x
            if fl is not None:
                x0 = max(x0, float(fl) + 2.0)
            if fr is not None:
                x1 = min(x1, float(fr) - 2.0)
        # clamp to the page bounds (same pixel space as the words)
        pg = pages_by_index.get(page)
        if pg and pg.width > 0:
            x0 = max(0.0, x0)
            x1 = min(float(pg.width), x1)
        else:
            x0 = max(0.0, x0)
        if pg and pg.height > 0:
            y0 = max(0.0, y0)
            y1 = min(float(pg.height), y1)
        else:
            y0 = max(0.0, y0)
        if x1 - x0 > 4 and y1 - y0 > 4:
            regions.append({
                "page": page,
                "x0": round(x0, 2), "y0": round(y0, 2), "x1": round(x1, 2), "y1": round(y1, 2),
                "ownerId": q.id,
            })

    q.crop_regions = regions
    q.visual_regions = [
        {"kind": b.kind.value, "page": b.page,
         "x0": round(b.x0, 2), "y0": round(b.y0, 2), "x1": round(b.x1, 2), "y1": round(b.y1, 2)}
        for b in q.boxes if b.kind in _VISUAL_KINDS
    ]
    # number must be inside one of the regions (a question whose number was trimmed is not crop-valid)
    number_ok = _number_contained(q, regions) if q.number_box else True
    q.crop_valid = bool(regions) and number_ok
    q.question_type = _infer_type(q, expected_options)


def validate_neighbor_leaks(
    questions: List[QuestionCandidate],
    metrics_by_page: Dict[int, Any],
) -> int:
    """Safety-net pass: detect crops that still contain another question's marker after plan_crops.

    After plan_crops the ownership freeze in _plan_one (slab_bottom) is the primary guard. This
    function is the secondary check — it catches any case where a crop's y1 slipped past a
    neighbour's marker (missed slab, merged question, cross-page boundary). For every such leak it:
      1. Truncates the crop at the neighbour's marker (auto-repair — NEVER deliver both).
      2. Sets question.neighbor_leak = True.
      3. Flags needs_review and adds "neighbor_leak" to review_reasons.
    Returns the count of crops repaired (0 means no leaks found)."""
    # Build the minimal set of anchor positions — where each question STARTS (its number marker).
    # We keep the marker's CENTRE X too: a leak is only real when the neighbour's marker sits INSIDE this
    # crop horizontally as well as vertically. Without the x-test the check is column-blind — on a 2-column
    # page a RIGHT-column question's marker shares a y-band with a LEFT-column crop and would falsely
    # truncate it (cutting that question's own diagram + options), and vice-versa. The marker of the next
    # question in the SAME column still lies inside the crop's x-span, so genuine same-column leaks are
    # still caught.
    anchors: List[Tuple[int, float, float, str]] = []  # (page, marker_cx, marker_cy, question_id)
    for q in questions:
        if q.number_box:
            anchors.append((int(q.number_box[0]),
                            (float(q.number_box[1]) + float(q.number_box[3])) / 2.0,
                            (float(q.number_box[2]) + float(q.number_box[4])) / 2.0,
                            q.id))
        elif q.boxes:
            b = min(q.boxes, key=lambda bb: bb.y0)
            anchors.append((b.page, (b.x0 + b.x1) / 2.0, float(b.y0), q.id))

    repaired = 0
    for q in questions:
        leaked = False
        for i, region in enumerate(q.crop_regions):
            pg = region["page"]
            ry0, ry1 = float(region["y0"]), float(region["y1"])
            m = metrics_by_page.get(pg)
            mh = (getattr(m, "median_h", 0) or 18.0) if m else 18.0

            # Other questions' markers that fall INSIDE this crop's rectangle (y-band AND x-span) on the same
            # page. The x-span test makes this COLUMN-AWARE: a neighbouring column's marker (different x) is
            # never treated as a leak into this column's crop.
            rx0, rx1 = float(region["x0"]), float(region["x1"])
            leaks = [cy for (ap, cx, cy, aqid) in anchors
                     if ap == pg and aqid != q.id and ry0 < cy < ry1 and rx0 <= cx <= rx1]
            if not leaks:
                continue

            # Auto-repair: truncate at the EARLIEST leaked marker (the nearest neighbour).
            truncate_y = min(leaks) - 0.6 * mh
            if truncate_y > ry0 + 4.0:
                q.crop_regions[i]["y1"] = round(truncate_y, 2)
            leaked = True
            repaired += 1

        if leaked:
            q.neighbor_leak = True
            if not q.needs_review:
                q.needs_review = True
            q.review_reasons = sorted(set(q.review_reasons + ["neighbor_leak"]))
            q.crop_valid = bool(q.crop_regions) and _number_contained(q, q.crop_regions)

    return repaired


def _number_contained(q: QuestionCandidate, regions: List[Dict[str, Any]]) -> bool:
    if not q.number_box:
        return True
    pg = int(q.number_box[0])
    nx0, ny0, nx1, ny1 = q.number_box[1], q.number_box[2], q.number_box[3], q.number_box[4]
    cx, cy = (nx0 + nx1) / 2.0, (ny0 + ny1) / 2.0
    for r in regions:
        if r["page"] == pg and r["x0"] <= cx <= r["x1"] and r["y0"] <= cy <= r["y1"]:
            return True
    return False
