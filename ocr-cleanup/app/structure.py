"""STRUCTURAL VALIDATOR — CV-only crop completeness check (NO OCR, NO AI).

Reuses the cleanup service's existing CV stack (OpenCV + NumPy + Pillow). It looks at the FINAL crop
image bytes (already produced by the Node OCR pipeline) and reports STRUCTURE only — it never reads
text and never decides a question number / question text / option text (those stay in OCR/Node):

  - edgeCutBottom / edgeCutTop : ink touching the crop's bottom/top edge ⇒ the question/options
                                 continue OFF the crop ⇒ the crop is INCOMPLETE (cut too early).
  - hasDiagram                 : a large 2-D connected ink component (figure / graph / structure) —
                                 so Node can PROTECT it and never split it off.
  - hasTable                   : a grid of long horizontal + vertical rules.
  - textRows                   : count of inked line-bands (a coarse structure signal).
  - crossColumnGutter          : a tall internal all-white vertical stripe with ink on BOTH sides ⇒
                                 the crop straddles two columns (options split across columns).

The COMPLETENESS verdict combines these CV signals with the Node-provided option count (Node owns the
real option count from OCR): an MCQ is complete only when it has its options (>=4) OR carries a
diagram, AND its content does not run off the bottom edge. If the CV stack is unavailable the caller
degrades to the Node-side validator — this module never raises into the request path.
"""
from __future__ import annotations

import io
from typing import Optional

try:  # CV stack is opt-in (requirements-cv.txt / INSTALL_CV=1). Absent ⇒ caller degrades to Node.
    import cv2  # type: ignore
    import numpy as np  # type: ignore
    from PIL import Image  # type: ignore

    _CV = True
except Exception:  # noqa: BLE001
    _CV = False

CV_AVAILABLE = _CV


def _load_gray(content: bytes):
    img = Image.open(io.BytesIO(content)).convert("L")
    return np.array(img)


def analyze_structure(
    content: bytes,
    mime: Optional[str],
    is_mcq: bool,
    node_option_count: int,
) -> dict:
    """Return a STRUCTURE report for a crop image. Pure CV, no text. Best-effort: any failure ⇒
    `complete=None` (unknown) so the caller keeps its own decision (degrade, never block wrongly)."""
    if not _CV:
        return {"complete": None, "reason": "cv_unavailable"}
    try:
        g = _load_gray(content)
        h, w = g.shape
        if h < 8 or w < 8:
            return {"complete": None, "reason": "too_small"}
        ink = (g < 150).astype("uint8")
        row_thresh = max(3, int(w * 0.02))
        band = max(2, h // 50)
        row_sum = ink.sum(axis=1)

        edge_cut_bottom = bool(row_sum[h - band:h].max() >= row_thresh)
        edge_cut_top = bool(row_sum[0:band].max() >= row_thresh)

        # inked line-bands (coarse text-row count)
        inked = row_sum >= row_thresh
        text_rows = 0
        prev = False
        for v in inked:
            if v and not prev:
                text_rows += 1
            prev = bool(v)

        # large 2-D connected component = diagram / graph / figure (not a thin text line)
        line_h = max(8, h // 40)
        num, _labels, stats, _c = cv2.connectedComponentsWithStats(ink, connectivity=8)
        has_diagram = False
        for i in range(1, num):
            x, y, cw, ch, area = stats[i]
            if ch > 3 * line_h and cw > 3 * line_h and area > line_h * line_h * 6:
                has_diagram = True
                break

        # table = long horizontal AND vertical rules co-existing
        h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, w // 4), 1))
        v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(20, h // 4)))
        horiz = cv2.morphologyEx(ink, cv2.MORPH_OPEN, h_kernel)
        vert = cv2.morphologyEx(ink, cv2.MORPH_OPEN, v_kernel)
        has_table = bool(int(horiz.sum()) > row_thresh and int(vert.sum()) > row_thresh)

        # cross-column gutter: a tall all-white vertical stripe with ink on both sides
        col_sum = ink.sum(axis=0)
        col_blank = col_sum <= max(1, int(h * 0.01))
        cross_column = False
        gutter_w = max(8, w // 25)
        run = 0
        for x in range(w):
            run = run + 1 if col_blank[x] else 0
            if run >= gutter_w and 0 < x - run and x < w - 1:
                left = int(col_sum[: x - run].sum())
                right = int(col_sum[x:].sum())
                if left > row_thresh * 3 and right > row_thresh * 3:
                    cross_column = True
                    break

        # COMPLETENESS: an MCQ needs its options (>=4 by OCR count) OR a diagram, and its content must
        # not run off the bottom edge. Cross-column ⇒ options split ⇒ not complete (Node should expand).
        complete = (not edge_cut_bottom) and (not cross_column)
        if is_mcq:
            complete = complete and (node_option_count >= 4 or has_diagram)

        return {
            "complete": bool(complete),
            "edgeCutTop": edge_cut_top,
            "edgeCutBottom": edge_cut_bottom,
            "hasDiagram": has_diagram,
            "hasTable": has_table,
            "textRows": text_rows,
            "crossColumnGutter": cross_column,
        }
    except Exception as e:  # noqa: BLE001
        return {"complete": None, "reason": f"error:{type(e).__name__}"}


# ─────────────────────────── Phase B: page-level structure ───────────────────────────
# CV-only, PROPOSAL-only page structure. NO OCR / NO AI / NO text. Everything is derived
# from the page's own geometry (Otsu ink + ratios relative to page size) — no coordinates,
# no hardcoded thresholds, no env knobs. Python PROPOSES; TS validates & decides ownership.
# It CANNOT know question numbers / sequences / option counts (those need OCR → stay in TS).


def _count_bands(arr) -> int:
    c, prev = 0, False
    for v in arr:
        if v and not prev:
            c += 1
        prev = bool(v)
    return c


def _detect_table(ink, h: int, w: int) -> bool:
    """A REAL table only — frame-aware. Page borders, scanner frames, institute frames
    and full-page dividers are removed FIRST; what remains must be an interior grid with
    multiple internal rows AND columns, repeated intersections (enclosed cells), localised
    and not touching the page edge. Anything else ⇒ KEEP IT (never a table)."""
    H = cv2.morphologyEx(ink, cv2.MORPH_OPEN,
                         cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, int(w * 0.12)), 1))).copy()
    V = cv2.morphologyEx(ink, cv2.MORPH_OPEN,
                         cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(20, int(h * 0.06))))).copy()

    # 1) FRAME REMOVAL — drop rules sitting in the page-edge margin (border / scanner frame).
    mx, my = max(3, int(w * 0.04)), max(3, int(h * 0.04))
    H[:my, :] = 0
    H[h - my:, :] = 0
    V[:, :mx] = 0
    V[:, w - mx:] = 0
    # 2) drop FULL-SPAN rules (>= 85% of the page) — separators / dividers / frame remnants.
    H[H.sum(axis=1) >= 0.85 * w, :] = 0
    V[:, V.sum(axis=0) >= 0.85 * h] = 0

    # 3) require a real interior grid: >= 3 internal horizontal AND >= 3 internal vertical
    #    rules, >= 6 repeated intersections (enclosed cells), localised (< 90% page width).
    hr = _count_bands(H.sum(axis=1) > max(20, int(w * 0.10)))
    vr = _count_bands(V.sum(axis=0) > max(20, int(h * 0.05)))
    if hr < 3 or vr < 3:
        return False
    n_inter = int(cv2.connectedComponents(cv2.bitwise_and(H, V))[0]) - 1
    if n_inter < 6:
        return False
    cols = np.where(V.sum(axis=0) > 0)[0]
    if cols.size == 0:
        return False
    return bool(int(cols.max() - cols.min()) < 0.9 * w)


def _page_structure(g) -> dict:
    h, w = g.shape
    ink = (cv2.threshold(cv2.GaussianBlur(g, (3, 3), 0), 0, 255,
                         cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1] > 0).astype("uint8")
    density = float(ink.mean())
    row_thresh = max(3, int(w * 0.01))

    # text line-bands (coarse row structure)
    rows = ink.sum(axis=1)
    inked = rows >= row_thresh
    bands = 0
    prev = False
    for v in inked:
        if v and not prev:
            bands += 1
        prev = bool(v)

    # 2-column layout: a tall, central, all-white vertical gutter with ink on BOTH sides.
    col = ink.sum(axis=0)
    col_blank = col <= max(1, int(h * 0.005))
    columns = 1
    gutter_w = max(8, w // 30)
    run = 0
    for x in range(w):
        run = run + 1 if col_blank[x] else 0
        if run >= gutter_w and (x - run) > w * 0.25 and x < w * 0.75:
            if int(col[: x - run].sum()) > row_thresh * 5 and int(col[x:].sum()) > row_thresh * 5:
                columns = 2
                break

    # figure/diagram/graph = a LOCALISED dense block — not the full-width text column,
    # and filled more than a region of text lines+gaps would be.
    num, _lab, stats, _c = cv2.connectedComponentsWithStats(ink, connectivity=8)
    line_h = max(8, h // 60)
    figures = 0
    for i in range(1, num):
        _x, _y, cw, ch, area = stats[i]
        big = ch > 5 * line_h and cw > 5 * line_h and area > line_h * line_h * 12
        localised = cw < 0.9 * w                  # not the full text column
        dense = area / max(1, cw * ch) > 0.12      # blocky, not sparse text lines
        if big and localised and dense:
            figures += 1

    # TABLE — frame-aware: strip page border / scanner frame / full-span dividers FIRST,
    # then require a real interior grid (enclosed cells). See _detect_table.
    has_table = _detect_table(ink, h, w)

    # PROPOSAL only, GEOMETRY only. "blank" is pure geometry (an empty page). Semantic page
    # types (answer-key / correction / appendix / ignore) are OCR-BOUND and stay with TS —
    # Python NEVER proposes them.
    blank = density < 0.002 and bands <= 1
    page_type = "blank" if blank else "content"

    return {
        "density": round(density, 4),
        "columns": columns,
        "textBands": bands,
        "figures": figures,
        "hasTable": has_table,
        "pageType": page_type,
        "ignoreCandidate": bool(blank),
    }


def analyze_document(content: bytes, mime: Optional[str]) -> dict:
    """Per-page CV structure PROPOSAL for a whole PDF (or one image). Best-effort: any
    failure ⇒ {available:False}. Never raises into the caller. PROPOSAL ONLY — it changes
    nothing; TS reconciles these signals with its OCR text and owns every decision."""
    if not _CV:
        return {"available": False, "reason": "cv_unavailable", "pages": []}
    try:
        m = (mime or "").lower()
        grays = []
        if "pdf" in m:
            import fitz  # PyMuPDF
            doc = fitz.open(stream=content, filetype="pdf")
            try:
                for page in doc:
                    # Modest fixed-cap render — structure only needs layout, not detail.
                    page_in = (max(page.rect.width, page.rect.height) / 72.0) or 11.0
                    dpi = int(max(100, min(150, 1600.0 / page_in)))
                    pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY, alpha=False)
                    grays.append(np.frombuffer(pix.samples, dtype="uint8")
                                 .reshape(pix.height, pix.width).copy())
            finally:
                doc.close()
        else:
            grays = [_load_gray(content)]
        pages = [{"page": i + 1, **_page_structure(g)} for i, g in enumerate(grays)]
        return {"available": True, "pageCount": len(pages), "pages": pages}
    except Exception as e:  # noqa: BLE001
        return {"available": False, "reason": f"error:{type(e).__name__}", "pages": []}
