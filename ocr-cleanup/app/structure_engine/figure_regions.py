"""Figure / diagram region detection on the PAGE PIXELS — the piece that makes a crop figure-aware.

WHY (the bug this fixes): a physics diagram, a graph, or a chemical structure usually carries a few
LETTER labels (a point "A"/"C", an axis "v²", a vertex "B"). The OCR reads those letters as words, and
the option detector — which only looks at token SHAPE — promotes a lone "(c)" / "B" to an MCQ option.
The crop planner's solution-trim then caps the crop at that false option, slicing the figure in half
(the user's "diagram had A C, OCR thought it was an option, so it cut half the diagram"). The token-only
figure detector (`visual_detectors.figure_gaps`) can't help here: it looks for a WORD-FREE band, but a
diagram WITH labels is not word-free, so it is never detected and never protected.

This module finds a figure by its DRAWING, not by the absence of words:

  1. ink mask of the page render (dark pixels),
  2. SUBTRACT every OCR word box  → only NON-text ink (figure strokes, axes, bonds, arrows) remains —
     so a labelled diagram is still found; its labels are removed, its line-art defines the box,
  3. SUBTRACT the page-frame border (a full-page rule rectangle is chrome, never a figure),
  4. close nearby strokes into blobs and keep the LARGE 2-D components (a figure occupies real area; a
     lone separator rule or a stray speck does not),
  5. merge overlapping/adjacent blobs into figure regions, returned in the WORD coordinate space.

A pure-text question leaves almost no ink after step 2, so it yields NO figure region — the detector is
a near no-op on text papers (the regression baselines). Pure geometry, no PDF/institute constant;
cv2-guarded; never raises (absent CV stack / no render ⇒ empty list).
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

from .models import Element, ElementKind, PageInput, QuestionCandidate

try:
    import cv2  # type: ignore
    import numpy as np  # type: ignore

    _CV = True
except Exception:  # noqa: BLE001
    _CV = False

FIGURE_CV_AVAILABLE = _CV

Box = Tuple[float, float, float, float]


def _merge_boxes(boxes: List[Box], gap: float) -> List[Box]:
    """Union boxes that overlap or sit within `gap` of each other (a figure split across components —
    bar + arc + arrows — becomes one region). Simple iterate-to-fixpoint; small N per page."""
    boxes = list(boxes)
    changed = True
    while changed:
        changed = False
        out: List[Box] = []
        while boxes:
            a = boxes.pop()
            ax0, ay0, ax1, ay1 = a
            merged = True
            while merged:
                merged = False
                rest: List[Box] = []
                for b in boxes:
                    bx0, by0, bx1, by1 = b
                    if (ax0 - gap <= bx1 and bx0 <= ax1 + gap and
                            ay0 - gap <= by1 and by0 <= ay1 + gap):
                        ax0, ay0, ax1, ay1 = min(ax0, bx0), min(ay0, by0), max(ax1, bx1), max(ay1, by1)
                        merged = True
                        changed = True
                    else:
                        rest.append(b)
                boxes = rest
            out.append((ax0, ay0, ax1, ay1))
        boxes = out
    return boxes


def detect_figure_regions(
    page: PageInput,
    median_h: float,
    frame: Optional[Tuple[Any, Any, Any, Any]] = None,
) -> List[Box]:
    """Non-text drawing regions of `page`, as (x0,y0,x1,y1) in the WORD/render coordinate space.

    `median_h` is the page's median text height (sets the stroke-merge + minimum-size scale — universal,
    no constant). `frame` (top,bot,left,right in word space, any None) is the detected page border so its
    rule rectangle is removed before component analysis. Returns [] when there is no render / no CV stack /
    no real drawing on the page."""
    if not _CV or not getattr(page, "image_base64", None):
        return []
    try:
        import base64 as _b64

        img = cv2.imdecode(np.frombuffer(_b64.b64decode(page.image_base64), np.uint8), cv2.IMREAD_GRAYSCALE)
        if img is None:
            return []
        H, W = img.shape[:2]
        if H < 40 or W < 40:
            return []
        sx = W / page.width if page.width else 1.0
        sy = H / page.height if page.height else 1.0
        mh_px = max(8.0, median_h * sy)

        ink = (img < 150).astype("uint8")

        # 1) SUBTRACT OCR text — paint out every word box (padded a little so glyph overhangs go too). What
        #    remains is non-text ink: a labelled diagram keeps only its strokes (its labels are erased).
        pad = max(2, int(0.15 * mh_px))
        for w in page.words:
            x0 = max(0, int(w.x0 * sx) - pad); x1 = min(W, int(w.x1 * sx) + pad)
            y0 = max(0, int(w.y0 * sy) - pad); y1 = min(H, int(w.y1 * sy) + pad)
            if x1 > x0 and y1 > y0:
                ink[y0:y1, x0:x1] = 0

        # 2) SUBTRACT the page frame + outer margins — a full-page border rectangle is chrome, not a figure.
        m = max(4, int(0.012 * W))
        ink[:m, :] = 0; ink[-m:, :] = 0; ink[:, :m] = 0; ink[:, -m:] = 0
        if frame:
            ft, fb, fl, fr = frame
            band = max(3, int(0.4 * mh_px))
            if ft is not None:
                yy = int(float(ft) * sy); ink[max(0, yy - band):yy + band, :] = 0
            if fb is not None:
                yy = int(float(fb) * sy); ink[max(0, yy - band):yy + band, :] = 0
            if fl is not None:
                xx = int(float(fl) * sx); ink[:, max(0, xx - band):xx + band] = 0
            if fr is not None:
                xx = int(float(fr) * sx); ink[:, max(0, xx - band):xx + band] = 0

        # 3) close strokes into blobs (kernel ≈ one text line so a dashed axis / broken bond joins up)
        k = max(5, int(0.6 * mh_px))
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
        closed = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, kernel)

        # 4) keep LARGE 2-D components — a figure occupies real area in BOTH dims; a thin separator rule
        #    (wide, ~1px tall) and stray specks are rejected.
        n, _lbl, stats, _cent = cv2.connectedComponentsWithStats(closed, connectivity=8)
        raw: List[Box] = []
        for i in range(1, n):
            x, y, w, h, area = stats[i]
            if w >= 0.85 * W and h >= 0.85 * H:
                continue  # page-spanning ⇒ the frame, not a figure
            if min(w, h) < 1.8 * mh_px:
                continue  # a thin rule / underline / single glyph stroke, not a 2-D drawing
            if w < 4.0 * mh_px or h < 2.5 * mh_px:
                continue  # too small to be a real figure
            if area < 2.0 * mh_px * mh_px:
                continue  # too little ink inside the bbox ⇒ scattered noise, not a drawing
            raw.append((x / sx, y / sy, (x + w) / sx, (y + h) / sy))

        return _merge_boxes(raw, gap=1.5 * median_h)
    except Exception:  # noqa: BLE001 — a bad render never fails the document
        return []


def _markers_by_col(
    questions: Sequence[QuestionCandidate], metrics_by_page: Dict[int, Any]
) -> Dict[Tuple[int, int], List[Tuple[float, str]]]:
    """Per (page, column): sorted (marker_top_y, question_id) START anchors — mirrors the crop planner so a
    figure is assigned to the SAME slab the crop will draw."""
    def _col(page: int, cx: float) -> int:
        mm = metrics_by_page.get(page)
        try:
            return mm.column_of(cx) if mm else 0
        except Exception:  # noqa: BLE001
            return 0

    by: Dict[Tuple[int, int], List[Tuple[float, str]]] = {}
    for q in questions:
        if q.number_box:
            pg = int(q.number_box[0]); my0 = float(q.number_box[2]); mcx = (q.number_box[1] + q.number_box[3]) / 2.0
        elif q.boxes:
            b = min(q.boxes, key=lambda bb: bb.y0); pg, my0, mcx = b.page, float(b.y0), (b.x0 + b.x1) / 2.0
        else:
            continue
        by.setdefault((pg, _col(pg, mcx)), []).append((my0, q.id))
    for v in by.values():
        v.sort()
    return by


def assign_figures_to_questions(
    questions: List[QuestionCandidate],
    figures_by_page: Dict[int, List[Box]],
    metrics_by_page: Dict[int, Any],
    pages_by_index: Optional[Dict[int, Any]] = None,
) -> int:
    """Own each detected figure to the question whose column-SLAB (its marker → the next question's marker
    in that column) contains the figure's centre — the SAME containment the crop planner uses, so the
    figure lands in exactly the crop that will be drawn. Adds it as an `ElementKind.DIAGRAM` box on that
    question so the crop planner (which already honours owned visual boxes) extends the crop through it and
    never trims it. Returns how many figures were attached.

    CONTIGUITY GUARD: a figure is attached ONLY when it is vertically ADJACENT to the owner's own TEXT
    (overlaps it, or sits within ~a few text lines of it). This matters when a question's number was unread
    (handwritten / faint): the missing question's slab then swallows the NEXT question's figure too, and
    claiming it would balloon the crop down across the gap into the neighbour (the circuit-pulled-into-the-
    string-question bleed). A figure separated from this question's text by a clear gap is left UNOWNED —
    safer to drop a figure than to merge two questions. A figure inside no slab is likewise left unowned.

    PAGE-SPANNING GUARD: a figure box that spans the page WIDTH (crosses both columns) AND covers most of
    its HEIGHT is not a single question's diagram — it is the page frame, a scan border, or background noise
    the word-subtraction missed (common on noisy scans). OWNING it as a DIAGRAM box breaks the crop: the
    planner cannot place a column region for a both-columns-wide box, so the owning question is delivered
    EMPTY or with zero regions, OR its crop balloons down into the next question. So such a box is never
    OWNED here. It is deliberately NOT removed from `figures_by_page` (this guard only governs ownership):
    `tag_protected_words` upstream still uses it to keep diagram labels out of options/markers, so the only
    effect is that the question's crop falls back to its own column slab — which already renders any real
    drawing that lies inside it (KEEP PIXELS; no content deleted). 0.85×W / 0.60×H is universal (a real
    per-question figure never fills a multi-question page), not a per-PDF constant."""
    if not figures_by_page:
        return 0
    pages_by_index = pages_by_index or {}
    by_col = _markers_by_col(questions, metrics_by_page)
    qby_id = {q.id: q for q in questions}
    attached = 0
    for page, figs in figures_by_page.items():
        m = metrics_by_page.get(page)
        mh = (getattr(m, "median_h", 0) or 18.0) if m else 18.0
        _pg = pages_by_index.get(page)
        _pw = float(getattr(_pg, "width", 0) or 0.0)
        _ph = float(getattr(_pg, "height", 0) or 0.0)
        _cols = list(getattr(m, "columns", []) or [])

        def _page_spanning(f) -> bool:
            # A figure that covers most of the page HEIGHT and is also page-WIDE — either ≥85% of the page
            # width, OR (on a multi-column page) crossing the gutter so it spans ≥2 columns' centres. Either
            # way it cannot be a single question's diagram; it is the frame / scan border / background noise.
            if _ph <= 0 or (f[3] - f[1]) < 0.60 * _ph:
                return False
            if _pw > 0 and (f[2] - f[0]) >= 0.85 * _pw:
                return True
            if len(_cols) >= 2:
                spanned = sum(1 for c in _cols if f[0] <= (c.left + c.right) / 2.0 <= f[2])
                if spanned >= 2:
                    return True
            return False

        figs = [f for f in figs if not _page_spanning(f)]

        def _col(cx: float) -> int:
            try:
                return m.column_of(cx) if m else 0
            except Exception:  # noqa: BLE001
                return 0

        for (fx0, fy0, fx1, fy1) in figs:
            fcx, fcy = (fx0 + fx1) / 2.0, (fy0 + fy1) / 2.0
            col = _col(fcx)
            anchors = by_col.get((page, col), [])
            owner_id = None
            for j, (my, qid) in enumerate(anchors):
                if my > fcy:
                    break
                nxt = anchors[j + 1][0] if j + 1 < len(anchors) else None
                if nxt is None or fcy < nxt:
                    owner_id = qid  # the last marker at-or-above the figure whose slab still encloses it
            q = qby_id.get(owner_id) if owner_id else None
            if q is None:
                continue
            # contiguity: the figure must touch / nearly touch this question's TEXT on this page+column. Any
            # non-visual owned box whose y-range overlaps the figure, or whose bottom is within ~3 lines
            # above the figure top (a diagram right under the stem/options). Otherwise the figure is across a
            # gap — most likely the next (missing-number) question's — so leave it unowned.
            gap = 3.0 * mh
            text = [b for b in q.boxes if b.kind != ElementKind.DIAGRAM and b.page == page
                    and _col((b.x0 + b.x1) / 2.0) == col]
            contiguous = any(
                (b.y0 - gap) <= fy1 and fy0 <= (b.y1 + gap) for b in text
            )
            if not contiguous:
                continue
            q.boxes.append(Element(kind=ElementKind.DIAGRAM, page=page, x0=fx0, y0=fy0, x1=fx1, y1=fy1,
                                   owner_id=q.id, confidence=0.6))
            q.has_diagram = True
            attached += 1
    return attached


def figure_boxes_for_page(
    figures_by_page: Dict[int, List[Box]], page: int
) -> List[Box]:
    return list(figures_by_page.get(page, []))


def point_in_any(boxes: Sequence[Box], x: float, y: float, pad: float = 0.0) -> bool:
    """True when (x,y) is inside any figure box (pad expands each box). Used by the option detector to
    REJECT an option-label candidate that actually sits inside a diagram (a point/axis/vertex label)."""
    for (x0, y0, x1, y1) in boxes:
        if x0 - pad <= x <= x1 + pad and y0 - pad <= y <= y1 + pad:
            return True
    return False


def tag_protected_words(words: Sequence[Any], figures: List[Box]) -> int:
    """Mark every word whose centre sits inside a detected figure as `protected=True`.

    A protected word is KEPT in every word list (KEEP PIXELS — it renders in the crop, its text is
    visible, it contributes to line geometry) but is SKIPPED by all structural consumers: marker
    extraction, option detection, column-geometry projection. A diagram point label ("A", "C", "x²")
    or a circuit node name is visual, not structural — it must never become a question marker, an MCQ
    option label, or a column-boundary anchor. Returns the count of words tagged."""
    if not figures:
        return 0
    tagged = 0
    for w in words:
        cx = (w.x0 + w.x1) / 2.0
        cy = (w.y0 + w.y1) / 2.0
        for (fx0, fy0, fx1, fy1) in figures:
            if fx0 <= cx <= fx1 and fy0 <= cy <= fy1:
                w.protected = True
                tagged += 1
                break
    return tagged
