"""Pipeline orchestrator — the exact flow the spec demands:

  Page → structural analysis → ownership graph → question candidate → continuation
  detection → merge detection → option ownership → completeness validation →
  confidence score → (return PROPOSAL) → TS validates → TS persists.

Python NEVER persists and NEVER crops here. It returns a structural PROPOSAL; TS is the
only authority that validates and persists. Any internal failure degrades to a safe
'REVIEW' proposal with empty questions so TS simply keeps its own behaviour.
"""
from __future__ import annotations

from typing import Any, Dict, List

from . import confidence_engine, crop_completeness_validator, review_router, validator
from .geometry import PageMetrics, compute_metrics
from .integrity_gate import compute_integrity
from .marker_extractor import extract_markers
from .marker_reconciler import reconcile_markers
from .merge_detector import build_groups
from .models import (
    DocumentAnalysis,
    DocumentInput,
    ElementKind,
    PageInput,
    PageKind,
    SCHEMA_VERSION,
)
from .crop_planner import plan_crops
from .ownership_completeness import build_heatmap
from .ownership_graph import build_questions
from .page_classifier import classify_page
from .repeated_chrome import chrome_bands, detect_chrome
from .visual_detectors import classify_question_visuals
from .promotion import registry as promotion_registry
from .question_end_detector import compute_segments
from .question_start_detector import detect_starts
from .sequence_validator import validate_sequence


def _col_has_question_text(page, col, line_tol) -> bool:
    """True when a column carries independent QUESTION/stem text — >=2 multi-word lines whose first token is
    NOT an option label. This is what tells a REAL second column (whose question NUMBERS may be unread, e.g.
    a 2-column page whose right-column numbers the OCR missed) apart from a false 2-up OPTION grid, whose
    spill column holds only option labels (B/D of each row). Used to decide whether a pixel column-split is
    genuine (keep) or spurious (revert). Universal: option-label shape + word count, no PDF constant."""
    from . import tokens as _tok
    from .geometry import group_lines as _gl
    cw = [w for w in page.words if col.left - 0.5 <= w.cx <= col.right + 0.5 and not getattr(w, "chrome", False)]
    n = 0
    for ln in _gl(cw, line_tol):
        ws = sorted(ln.words, key=lambda w: w.x0)
        if len(ws) >= 3 and not _tok.is_option_label(ws[0].text):
            n += 1
            if n >= 2:
                return True
    return False


def _markers_single_cluster(page, char_w) -> bool:
    """True when every question marker on the page sits in ONE x-cluster (a single left margin) — the
    signature of a SINGLE-column page. A real 2-column page (incl. one whose right-column numbers were
    unread, e.g. RE NEET's cover) has markers in >=2 well-separated x-clusters. Same gap as the marker-
    driven column correction (step 2b.2): a new cluster starts on a jump > 8 char-widths."""
    xs = sorted(((mk.x0 + mk.x1) / 2.0) for mk in page.markers)
    if len(xs) < 2:
        return True
    gap = 8.0 * max(char_w, 1.0)
    return all((b - a) <= gap for a, b in zip(xs, xs[1:]))


def _refine_gutter_crossed(page, columns, line_tol) -> bool:
    """True when a meaningful share of BODY lines SPAN the column gutter (ink fully left AND fully right of
    it). A genuine 2-column page keeps every line within one column, so ~no line crosses; a SINGLE-column
    page whose pixel refiner split a 2-up OPTION grid has full-width stem / option-row / explanation prose
    crossing the gutter on most lines (PHYCHE). Chrome excluded; document-derived threshold, no constant."""
    if len(columns) < 2:
        return False
    from .geometry import group_lines as _gl
    gutters = [(columns[i].right + columns[i + 1].left) / 2.0 for i in range(len(columns) - 1)]
    lines = _gl([w for w in page.words if not getattr(w, "chrome", False)], line_tol)
    if not lines:
        return False
    crossed = 0
    for ln in lines:
        for g in gutters:
            if any(w.x1 <= g for w in ln.words) and any(w.x0 >= g for w in ln.words):
                crossed += 1
                break
    return crossed >= max(2, int(0.20 * len(lines)))


def _page_is_two_column(page, char_w) -> bool:
    """True when a page's markers form >=2 x-clusters EACH with >=2 markers — the structure of a REAL
    2-column page (questions down both columns). One stray cluster or a lone marker doesn't count."""
    xs = sorted(((mk.x0 + mk.x1) / 2.0) for mk in page.markers)
    if len(xs) < 4:
        return False
    gap = 8.0 * max(char_w, 1.0)
    clusters = [[xs[0]]]
    for a, b in zip(xs, xs[1:]):
        (clusters.append([b]) if (b - a) > gap else clusters[-1].append(b))
    return sum(1 for c in clusters if len(c) >= 2) >= 2


def _is_single_column_2up(page, metrics) -> bool:
    """Per-page test for the refine-split revert (step 2b.1), applied ONLY when the whole document is
    single-column (see `_doc_single_column`). A page is a wrongly-split 2-up OPTION grid when its markers
    form ONE x-cluster AND many body lines cross the gutter — the case `_col_has_question_text` is fooled by
    (a solved paper's full-width EXPLANATION prose spilling past the gutter, PHYCHE). The document-level gate
    is what keeps this OFF every multi-column paper (AD/AIOTS/25REP/RE NEET), so that path is untouched."""
    return _markers_single_cluster(page, metrics.char_w) and _refine_gutter_crossed(page, metrics.columns, metrics.line_tol)


def analyze_document(payload: Dict[str, Any]) -> Dict[str, Any]:
    try:
        doc = DocumentInput.from_dict(payload)
        # PER-REQUEST OCR mode (set by the Node document classifier — NOT a global env flag). A SCANNED
        # document classified upstream sends ocrMode="scanned" (or reocr=true); Python then re-OCRs the page
        # renders with RapidOCR before analysis. A DIGITAL document omits it and keeps the platform tokens.
        # This is the "OCR engine selection" stage: the ownership/crop/validation engine below is identical
        # for both. Falls back to the STRUCTURE_RAPIDOCR env only for manual/dev use.
        _mode = str(payload.get("ocrMode") or "").lower()
        reocr = bool(payload.get("reocr")) or _mode in ("scanned", "rapid", "rapidocr")
        result = _analyze(doc, reocr=reocr).to_dict()
        # Expose the repeated header/footer BAND per page so the crop renderer (Python OR TS) can CLIP
        # every crop to (header_bottom, footer_top) — the repeated institute header/footer (e.g. the
        # 'SK LEARNINGS' banner) then never appears in a question crop. Content-safe (top/bottom bands
        # only). Keyed by 1-based page index (the words/render space the crop builder uses).
        from .chrome_pixels import merge_bands, pixel_chrome_bands
        from .repeated_chrome import chrome_bands, detect_chrome

        token_bands = chrome_bands(doc.pages, detect_chrome(doc.pages))
        # PIXEL chrome too — catches an IMAGE header/footer (logo, banner, scan border) the token
        # detector cannot see. Merged into the tightest safe clip so the TS box-union fallback also
        # clips an image footer. The live crop regions already bake this in (see _analyze).
        pixel_bands = pixel_chrome_bands(doc.pages)
        page_heights = {p.index: p.height for p in doc.pages}
        bands = merge_bands(token_bands, pixel_bands, page_heights)
        result["chromeBands"] = {str(pi): [round(b[0], 2), round(b[1], 2)] for pi, b in bands.items()}
        return result
    except Exception as e:  # noqa: BLE001 — never raise into the request path
        return {
            "documentId": str(payload.get("documentId", payload.get("document_id", ""))),
            "schemaVersion": SCHEMA_VERSION,
            "pageClasses": [],
            "questions": [],
            "orphans": [],
            "sequence": {},
            "confidence": 0.0,
            "recommendation": "REVIEW",
            "integrity": {"status": "STOP", "nEqualsNEqualsC": False, "ownershipViolations": ["engine_error"]},
            "questionCount": {"logicalQuestionCount": 0, "confidence": 0.0, "anomalies": [{"type": "engine_error"}]},
            "ownershipHeatmap": [],
            "cropGate": "REVIEW",
            "promotion": promotion_registry(),
            "notes": [f"engine_error:{type(e).__name__}"],
        }


def _inject_badge_markers(
    pages: List[PageInput], metrics_by_page: Dict[int, "PageMetrics"] | None = None
) -> None:
    """Read seal/badge question numbers off each page render (CV) and inject them as markers carrying the
    TRUE value. Self-contained + best-effort: no render → no-op; no CV stack → no-op; never raises. Coords
    scale from render-pixel space to the OCR-point space the markers live in. Deduped against a token
    marker with the same value already on the page (a number that WAS read is not double-counted)."""
    metrics_by_page = metrics_by_page or {}
    if not any(p.image_base64 for p in pages):
        return
    # The per-seal RapidOCR number reader (badge_detector) costs ~47s on a 19-page paper but reads only
    # ~14 of ~33 seals — and seal_shapes (0.4s) finds ALL the seals as numberless markers that the
    # sequence gap-fill then numbers (the 178/180 path). So the OCR read is now redundant + the dominant
    # latency; it is OFF by default and only runs when STRUCTURE_BADGE_OCR is explicitly enabled (e.g. a
    # paper whose numbering is too irregular for gap-fill). Quality is unchanged; the slow step is gone.
    import os as _os
    badge_ocr = _os.environ.get("STRUCTURE_BADGE_OCR", "").lower() in ("1", "true", "yes", "on")
    try:
        import base64 as _b64

        import cv2  # type: ignore
        import numpy as _np  # type: ignore

        from .badge_detector import detect_badges
        from .models import Marker
    except Exception:  # noqa: BLE001 — CV stack absent ⇒ skip badge recovery entirely
        return
    for p in pages:
        if not p.image_base64:
            continue
        try:
            img = cv2.imdecode(_np.frombuffer(_b64.b64decode(p.image_base64), dtype=_np.uint8), cv2.IMREAD_COLOR)
            if img is None or img.shape[0] < 10 or img.shape[1] < 10:
                continue
            badges = detect_badges(img, img.shape[1]) if badge_ocr else []
            sx = p.width / img.shape[1] if img.shape[1] else 1.0
            sy = p.height / img.shape[0] if img.shape[0] else 1.0
            present = {mk.num for mk in p.markers if mk.num is not None}
            for b in (badges or []):
                if b["number"] in present:
                    continue
                p.markers.append(Marker(num=int(b["number"]), x0=b["x0"] * sx, y0=b["y0"] * sy,
                                        x1=b["x1"] * sx, y1=b["y1"] * sy, punct="badge"))
                present.add(b["number"])
            # RECALL — a SEAL is a question START even when its number could NOT be OCR-read (white-on-
            # black). Detect every seal by SHAPE and inject the ones not already covered (by position) as
            # NUMBERLESS markers; the sequence reconciler/gap-fill assigns the value. Lifts badge recall
            # on a paper whose seals are mostly unreadable so a badged question is COUNTED + segmented.
            # A plain-text page has no seals ⇒ no-op.
            #
            # MARGIN GATE (precision): a real question-number badge sits at a COLUMN'S LEFT edge — never
            # mid-content and never in the GUTTER. A faint diagonal watermark/logo swoosh leaves a solid
            # square blob in the gutter that otherwise passes the shape+core test and injects a PHANTOM
            # question (which both inflates the count and truncates the neighbouring crop at its false
            # marker). So a seal is accepted only when its left edge is near a detected column's left. With
            # no column metrics (single-column / unknown) the page's content-left is the only anchor.
            from .seal_shapes import detect_seal_shapes
            m = metrics_by_page.get(p.index)
            cols = list(m.columns) if (m and m.columns) else []
            margin_tol = max(2.5 * (getattr(m, "median_h", 0) or 18.0), 0.05 * (p.width or 1000.0))
            # A question-number seal sits at a COLUMN'S LEFT MARGIN. For the RIGHT column the seal sits in
            # the gutter-side margin JUST LEFT of the text, so its box straddles the column's left edge —
            # its left edge is within ~a seal-width of that column's text-left. Accept any seal whose left
            # edge is near ANY column's left (incl. the single-column content-left); reject only blobs deep
            # in content / floating mid-gutter (far from every column left). This is what recovers the
            # right-column badges (8,21,29,38,…) the OCR never read.
            margins = [c.left for c in cols] if cols else [min((w.x0 for w in p.words), default=0.0)]
            covered = [(mk.x0, mk.y0) for mk in p.markers]
            for (qx0, qy0, qx1, qy1) in detect_seal_shapes(img):
                px0, py0 = qx0 * sx, qy0 * sy
                if all(abs(px0 - cl) > margin_tol for cl in margins):
                    continue  # not at any column's left margin ⇒ not a question badge
                tol = max(8.0, (qx1 - qx0) * sx * 0.9)
                if any(abs(cx - px0) <= tol and abs(cy - py0) <= tol for (cx, cy) in covered):
                    continue
                p.markers.append(Marker(num=None, x0=px0, y0=py0, x1=qx1 * sx, y1=qy1 * sy, punct="badge"))
                covered.append((px0, py0))
        except Exception:  # noqa: BLE001 — a single bad page render never fails the document
            continue


def _number_ocr_enabled() -> bool:
    # DEFAULT OFF. The RapidOCR margin re-read recovers missing numbers (scanned/handwritten) but costs
    # ~100s on a poor-scan document — enough that on the live path it can push the analyze call toward the
    # 180s HTTP timeout / trip the circuit breaker, which discards the WHOLE Python result and falls the
    # live app back to the raw TS draft set (the broken crops). So the fast, reliable geometry + grid fixes
    # ship by default and reach production; the number recovery is OPT-IN (STRUCTURE_NUMBER_OCR=1) for when
    # count completeness matters more than latency. Re-enable by default once the pass is optimised.
    import os as _os

    return _os.environ.get("STRUCTURE_NUMBER_OCR", "0").lower() in ("1", "true", "yes", "on")


def _document_under_detecting(pages) -> bool:
    """True when the platform-OCR markers have SIGNIFICANT gaps — the signal that numbers were missed (a
    poor scan or handwritten numbering) and the OCR recovery is worth its cost. A clean digital PDF whose
    numbers are contiguous returns False, so the recovery pass — and its latency — is skipped entirely."""
    nums = sorted({mk.num for p in pages for mk in p.markers if mk.num})
    if len(nums) < 3:
        return True  # almost nothing read ⇒ definitely try to recover
    span = nums[-1] - nums[0] + 1
    return (span - len(nums)) >= max(5, int(0.08 * span))


def _recover_missing_numbers_handwritten(pages, metrics_by_page) -> Dict[str, Any]:
    """GAP-DRIVEN handwritten-number RECOVERY across IN_COLUMN, CROSS_COLUMN and CROSS_PAGE gaps. Handwritten
    OCR is a RECOVERY engine, not a detector: it runs ONLY where the detected question SEQUENCE has a hole, and
    re-OCRs ONLY the small candidate region(s) around it — never a whole page, never the whole document, never
    an already-detected question.

    Flow: Tesseract detect → reconcile → token gap-fill → THIS. By here the sequence is established; we compute
    the EXACT missing numbers, group them into runs bounded by accepted, reading-adjacent markers (N-1 … N+1),
    and CLASSIFY each gap by where those bounds sit:
       • IN_COLUMN    — N-1 and N+1 in the SAME page+column → search the single band BETWEEN them;
       • CROSS_COLUMN — same page, ADJACENT columns (left col … right col) → search bottom(prev column) +
                        top(next column);
       • CROSS_PAGE   — N-1 on page P, N+1 on page P+1 → search bottom(prev page) + top(next page).
    Cross-column and cross-page are NORMAL question-paper layouts, recovered the same safe way — never the whole
    page/document, only the boundary bands. A read value is PROMOTED only when all three continuities hold:
       • SEQUENCE   — the value is one of THIS gap's missing numbers (we searched for N and found N);
       • LAYOUT     — it sits at the column's LEFT margin (where question numbers live), inside the band;
       • OWNERSHIP  — not on an existing marker AND it OWNS a stem (≥2 content words below it); for an IN_COLUMN
                      split it must also separate it from the previous question (≥2 words above).
    Anything else is IGNORED (a gap left for review beats a wrong number). Master-gated by STRUCTURE_NUMBER_OCR
    (default OFF). Returns stats (incl. per-gap-type breakdown) for the runtime log; `regions == 0` whenever
    there is no gap (or it is disabled). Never raises."""
    def _bt():
        return {"regions": 0, "recovered": [], "rejected": []}

    stats: Dict[str, Any] = {"enabled": _number_ocr_enabled(), "available": False, "gaps": [],
                             "regions": 0, "recovered": [], "rejected": [],
                             "byType": {"IN_COLUMN": _bt(), "CROSS_COLUMN": _bt(), "CROSS_PAGE": _bt()}}
    # GAP DETECTION runs ALWAYS (pure sequence math, no OCR) so the runtime log can always report what is
    # missing — only the handwritten-OCR EXECUTION below is gated. accepted numbered markers (post reconcile
    # + token gap-fill), with page+column+y — the detected sequence.
    acc: List[tuple] = []  # (page, col, y0, value, page_obj, marker)
    for p in pages:
        m = metrics_by_page.get(p.index)
        if not m:
            continue
        for mk in p.markers:
            if mk.num is not None:
                try:
                    col = m.column_of((mk.x0 + mk.x1) / 2.0)
                except Exception:  # noqa: BLE001
                    col = 0
                acc.append((p.index, col, mk.y0, int(mk.num), p, mk))
    nums = sorted({a[3] for a in acc})
    if len(nums) < 2:
        return stats
    present = set(nums)
    gaps = [n for n in range(nums[0], nums[-1] + 1) if n not in present]
    stats["gaps"] = gaps
    # ── GATES: only run handwritten OCR when enabled AND a gap exists AND a render is present. ──
    if not stats["enabled"]:
        return stats   # recovery disabled (STRUCTURE_NUMBER_OCR off) — gaps still reported above
    if not gaps:
        return stats   # NO GAP → STOP. Handwritten OCR never runs.
    if not any(getattr(p, "image_base64", None) for p in pages):
        return stats
    try:
        from . import number_ocr
        from .models import Marker
    except Exception:  # noqa: BLE001
        return stats
    if not number_ocr.available():
        return stats
    stats["available"] = True

    by_val = {a[3]: a for a in acc}
    _decoded: Dict[int, Any] = {}

    def _img(p):
        if p.index not in _decoded:
            _decoded[p.index] = number_ocr._decode(p.image_base64) if p.image_base64 else None
        return _decoded[p.index]

    def _content_extent(page_obj, colg, mh):
        ys0 = [w.y0 for w in page_obj.words if colg.left - mh <= w.cx <= colg.right + mh]
        ys1 = [w.y1 for w in page_obj.words if colg.left - mh <= w.cx <= colg.right + mh]
        top = (min(ys0) - mh) if ys0 else (0.05 * (page_obj.height or 0))
        bot = (max(ys1) + mh) if ys1 else (0.95 * (page_obj.height or 0))
        return top, bot

    def _recover_band(page_obj, colg, y_lo, y_hi, missing_set, neigh_x, require_above, gtype, mh):
        """OCR ONE column-left margin band [y_lo,y_hi], validate each candidate 3-way, promote. Bounded —
        never the whole page. Updates stats (total + per-type)."""
        bt = stats["byType"][gtype]
        if y_hi - y_lo < mh:
            return
        img = _img(page_obj)
        if img is None:
            return
        stats["regions"] += 1
        bt["regions"] += 1
        existing = [(mk.x0, mk.y0) for mk in page_obj.markers]
        margin_tol = max(2.0 * mh, 0.04 * (page_obj.width or 1000.0))
        for (val, fx0, fy0, fx1, fy1) in sorted(
            number_ocr.detect_numbers_in_region(img, colg, y_lo, y_hi, mh), key=lambda t: t[2]
        ):
            # (1) SEQUENCE — only a value that is a missing number of THIS gap (and not already recovered)
            if val not in missing_set or val in present:
                stats["rejected"].append([val, "sequence", gtype]); bt["rejected"].append(val); continue
            # (2) LAYOUT — at the column LEFT margin (like the neighbours' numbers), inside the band
            if abs(fx0 - colg.left) > margin_tol and all(abs(fx0 - nx) > margin_tol for nx in neigh_x):
                stats["rejected"].append([val, "layout_margin", gtype]); bt["rejected"].append(val); continue
            if not (y_lo - 1.0 <= fy0 <= y_hi + 1.0):
                stats["rejected"].append([val, "layout_region", gtype]); bt["rejected"].append(val); continue
            # (3) OWNERSHIP — not on an existing marker; OWNS a stem (≥2 words below); IN_COLUMN also ≥2 above
            if any(abs(ex - fx0) <= mh and abs(ey - fy0) <= mh for (ex, ey) in existing):
                stats["rejected"].append([val, "ownership_dup", gtype]); bt["rejected"].append(val); continue
            below = sum(1 for w in page_obj.words
                        if fy0 < w.y0 < y_hi + mh and colg.left - mh <= w.cx <= colg.right + mh)
            above = sum(1 for w in page_obj.words
                        if y_lo - mh < w.y0 < fy0 and colg.left - mh <= w.cx <= colg.right + mh)
            if below < 2 or (require_above and above < 2):
                stats["rejected"].append([val, "ownership_split", gtype]); bt["rejected"].append(val); continue
            # PROMOTE — all three continuities passed
            page_obj.markers.append(Marker(num=int(val), x0=fx0, y0=fy0, x1=fx1, y1=fy1, punct="hw"))
            page_obj.markers.sort(key=lambda x: x.y0)
            present.add(val); existing.append((fx0, fy0))
            stats["recovered"].append(int(val)); bt["recovered"].append(int(val))

    # group consecutive missing numbers into runs [a..b] bounded by accepted (a-1) and (b+1)
    runs: List[tuple] = []
    i = 0
    while i < len(gaps):
        j = i
        while j + 1 < len(gaps) and gaps[j + 1] == gaps[j] + 1:
            j += 1
        runs.append((gaps[i], gaps[j]))
        i = j + 1

    for (a, b) in runs:
        prev = by_val.get(a - 1)
        nxt = by_val.get(b + 1)
        if not prev or not nxt:
            continue  # no bounding pair (document edge) — nothing to scope against
        ppage, pcol, py0, _pv, pobj, pmk = prev
        npage, ncol, ny0, _nv, nobj, nmk = nxt
        pm = metrics_by_page.get(ppage); nm = metrics_by_page.get(npage)
        if not pm or not nm or not pm.columns or not nm.columns:
            continue
        if pcol >= len(pm.columns) or ncol >= len(nm.columns):
            continue
        pcolg, ncolg = pm.columns[pcol], nm.columns[ncol]
        pmh, nmh = (pm.median_h or 18.0), (nm.median_h or 18.0)
        missing_set = set(range(a, b + 1))
        neigh_x = [pmk.x0, nmk.x0]

        if ppage == npage and pcol == ncol:
            # IN_COLUMN — one band strictly between the two markers
            if ny0 > py0:
                _recover_band(pobj, pcolg, py0 + 0.8 * pmh, ny0 - 0.2 * pmh,
                              missing_set, neigh_x, require_above=True, gtype="IN_COLUMN", mh=pmh)
        elif ppage == npage:
            # CROSS_COLUMN — bottom(previous column) + top(next column); never the whole page
            _, p_bot = _content_extent(pobj, pcolg, pmh)
            n_top, _ = _content_extent(nobj, ncolg, nmh)
            _recover_band(pobj, pcolg, py0 + 0.8 * pmh, p_bot,
                          missing_set, neigh_x, require_above=True, gtype="CROSS_COLUMN", mh=pmh)
            _recover_band(nobj, ncolg, n_top, ny0 - 0.2 * nmh,
                          missing_set, neigh_x, require_above=False, gtype="CROSS_COLUMN", mh=nmh)
        else:
            # CROSS_PAGE — bottom(previous page) + top(next page); never the whole document
            _, p_bot = _content_extent(pobj, pcolg, pmh)
            n_top, _ = _content_extent(nobj, ncolg, nmh)
            _recover_band(pobj, pcolg, py0 + 0.8 * pmh, p_bot,
                          missing_set, neigh_x, require_above=True, gtype="CROSS_PAGE", mh=pmh)
            _recover_band(nobj, ncolg, n_top, ny0 - 0.2 * nmh,
                          missing_set, neigh_x, require_above=False, gtype="CROSS_PAGE", mh=nmh)
    return stats


def _detect_grid_pages(pages) -> set:
    """Page indices that are a full-page MULTI-COLUMN TABLE GRID — an answer key / error-analysis sheet /
    OMR / marks table — NOT question content. Such a page is dominated by a regular grid: MANY horizontal
    rule lines (the rows) AND SEVERAL vertical rule lines (the columns). A real question page has at most a
    couple of box/frame verticals and few horizontals, so requiring BOTH a high horizontal-rule count and a
    multi-column vertical-rule count isolates the grid without catching a question page that merely has a
    boxed sub-question. Universal (pixel rules, no keyword / institute constant); these pages are excluded
    from question extraction so their numbered rows never become questions. cv2-free; never raises."""
    try:
        import base64 as _b64
        import io as _io

        import numpy as _np  # type: ignore
        from PIL import Image  # type: ignore
    except Exception:  # noqa: BLE001
        return set()
    grids = set()
    for p in pages:
        if not getattr(p, "image_base64", None):
            continue
        try:
            g = _np.asarray(Image.open(_io.BytesIO(_b64.b64decode(p.image_base64))).convert("L"))
            H, W = g.shape[:2]
            if H < 40 or W < 40:
                continue
            dark = g < 140
            body = dark[int(H * 0.12):int(H * 0.93), :]
            rowfrac = body.mean(axis=1)            # per-row dark fraction (a horizontal rule ≈ full width)
            colfrac = body.mean(axis=0)            # per-col dark fraction (a vertical rule ≈ full height)
            hr = prev = 0
            prev = -10
            for y, f in enumerate(rowfrac):
                if f > 0.45 and y - prev > 3:
                    hr += 1
                    prev = y
            vr = 0
            prev = -10
            for x, f in enumerate(colfrac):
                if f > 0.30 and x - prev > 3:
                    vr += 1
                    prev = x
            if hr >= 12 and vr >= 6:
                grids.add(p.index)
        except Exception:  # noqa: BLE001
            continue
    return grids


def _is_pure_options_tail(lines) -> bool:
    """True when a block is ONLY a question's ANSWER block — an options lead-in ('choose the correct
    answer…', 'in the light of the above statements…') and/or option-family lines — with NO independent
    question STEM. Such a block is the PRECEDING question's options (split off by an intervening table or
    statement block), so `_fill_sequence_gaps` must NOT inject a missing-number marker inside it (that turns
    the options into a phantom question and strips them off the real one). Evidence: option labels present
    AND no stem line. A real missing question always has a stem, so this returns False for it."""
    from . import tokens as _tok
    _LEADIN = ("choose the correct", "in the light of the above", "from the options given",
               "options given below", "correct answer from")
    opt_lines = stem_lines = 0
    for ln in lines:
        ws = sorted(ln.words, key=lambda w: w.x0)
        if not ws:
            continue
        if _tok.is_option_label(ws[0].text):
            opt_lines += 1
            continue
        txt = " ".join(w.text for w in ws).lower()
        if any(c in txt for c in _LEADIN):
            continue  # an options lead-in line — not an independent stem
        if len(ws) >= 3:
            stem_lines += 1
    return opt_lines >= 1 and stem_lines == 0


def _fill_sequence_gaps(qpages, metrics_by_page) -> None:
    """Synthesize a marker for a question whose number OCR missed but whose content is present. For each pair
    of accepted numbered markers that are ADJACENT in reading order (same page+column, B directly below A)
    and differ by exactly 2 in value (one number N missing between them), look at the words BETWEEN them: a
    complete MCQ is the previous question's option tail, a clear paragraph gap, then the missing question's
    stem+options. Split at the largest gap and place a marker for N (value from the sequence) at the start of
    the block after it. Guards keep it safe: a single missing number, ≥6 words / ≥3 lines of content, a
    boundary gap wider than a line, and real content on BOTH sides — so a single long question is never split
    into two. Best-effort, never raises; no OCR / PDF constant."""
    try:
        from .geometry import group_lines
        from .models import Marker
    except Exception:  # noqa: BLE001
        return
    acc = []  # (page, col, y0, value, page_obj)
    for p in qpages:
        m = metrics_by_page.get(p.index)
        if not m:
            continue
        for mk in p.markers:
            if mk.num is not None:
                acc.append((p.index, m.column_of((mk.x0 + mk.x1) / 2.0), mk.y0, int(mk.num), p))
    acc.sort(key=lambda t: (t[0], t[1], t[2]))
    _globally_present = {t[3] for t in acc}  # question numbers already accepted on ANY page
    from . import tokens as _tok
    for i in range(len(acc) - 1):
        pa, ca, ya, va, pobj = acc[i]
        pb, cb, yb, vb, _ = acc[i + 1]
        if pa != pb or vb != va + 2 or va + 1 in _globally_present:
            continue  # same page, a single missing number, not already present elsewhere (cross-page)
        m = metrics_by_page[pa]
        if not m.columns:
            continue
        mh = m.median_h or 18.0
        if ca == cb and yb > ya and ca < len(m.columns):
            # ── SAME-COLUMN single-number gap (existing behaviour) ──
            col = m.columns[ca]
            region = [w for w in pobj.words
                      if col.left - 0.5 <= w.cx <= col.right + 0.5 and (ya + 0.5 * mh) < w.y0 < (yb - 0.2 * mh)]
            if len(region) < 6:
                continue  # not enough content between them to be a whole question
            lines = sorted(group_lines(region, m.line_tol), key=lambda ln: ln.y0)
            if len(lines) < 3:
                continue
            best_gap, split = 0.0, 0
            for k in range(1, len(lines)):
                g = lines[k].y0 - lines[k - 1].y1
                if g > best_gap:
                    best_gap, split = g, k
            # a CLEAR paragraph boundary, with the previous question's tail before it and ≥2 lines after it
            if best_gap < 1.2 * mh or split < 1 or len(lines) - split < 2:
                continue
            start = lines[split]
            # FIX B layer 1: do NOT inject when the would-be new question (from the split down to the NEXT
            # existing start in this column — a numbered marker OR a markerless badge/structural seal the reader
            # couldn't read) is a PURE OPTIONS block (a lead-in + option-family lines, no stem). That block is the
            # previous question's OPTIONS split off by an intervening table/statement (AD 2601 Q119), not a new
            # question; injecting here makes a phantom and strips the options off the real question. Real missing
            # questions have a stem here, so this never skips them.
            _next_y = yb
            for _mk in pobj.markers:
                if m.column_of((_mk.x0 + _mk.x1) / 2.0) == ca and start.y0 < _mk.y0 < _next_y:
                    _next_y = _mk.y0
            if _is_pure_options_tail([ln for ln in lines if start.y0 <= ln.y0 < _next_y]):
                continue
            pobj.markers.append(Marker(num=va + 1, x0=col.left, y0=start.y0,
                                       x1=col.left + mh, y1=start.y1, punct="gap"))
            pobj.markers.sort(key=lambda x: x.y0)
        elif cb == ca + 1 and cb < len(m.columns):
            # ── CROSS-COLUMN single-number gap (FIX A) ── va is the LAST question of column ca, vb the FIRST of
            # the NEXT column cb; the missing va+1 is a complete question at the TOP of column cb (above vb),
            # which per-element ownership otherwise attaches to va as a cross-column SPILL (AD 2601 Q116
            # swallowing Q117). Inject va+1 at the top of column cb ONLY when that block is itself a COMPLETE
            # question — a stem near its top PLUS a complete option block (>=3 option labels) — so a genuine
            # cross-column spill (options-only / a bare continuation, no fresh stem) is never split.
            colb = m.columns[cb]
            # CHROME-EXCLUDED so the repeated institute HEADER at the column top is never mistaken for a stem,
            # and so a CROSS-PAGE continuation (the previous question's options spilling to this column top,
            # with NO fresh stem) is correctly rejected — the stem test below then fails. AD 2601 Q117 begins
            # with a real stem ("Given below are two statements"), so it still qualifies; 25REP's header +
            # continuation-options column tops do not.
            region = [w for w in pobj.words
                      if colb.left - 0.5 <= w.cx <= colb.right + 0.5 and not getattr(w, "chrome", False)
                      and (m.content_y0 - 0.5 * mh) < w.y0 < (yb - 0.2 * mh)]
            if len(region) < 6:
                continue
            lines = sorted(group_lines(region, m.line_tol), key=lambda ln: ln.y0)
            if len(lines) < 3:
                continue
            # The missing question begins at the FIRST stem line that is PRECEDED by recognised OPTION lines —
            # the previous (cross-column) question's option spill at this column's top. AD 2601: Q116's options
            # "(a) A and B only…" spill to col1 top, THEN Q117's stem "Given below are two statements" begins.
            # That leading clean option spill is the exact, OCR-robust separator between this case and a cross-
            # PAGE continuation whose column top is a garbled/non-option line or a bare stem (25REP pp.3/6/17) —
            # none of which is preceded by a recognised option spill, so all are rejected. Inject at the stem
            # (after the spill) so the previous question keeps its spilled options.
            stem_idx = None
            for k, ln in enumerate(lines):
                ws = sorted(ln.words, key=lambda w: w.x0)
                if any(_tok.is_option_label(w.text) for w in ws):
                    # an option-spill line — including a wrapped continuation row whose OWN leading label the
                    # OCR garbled ("(c)"→"C") but which still carries a sibling label ("(d)"). Checking the
                    # whole line (not just the first token) keeps that row with the PREVIOUS question instead
                    # of mistaking it for the missing question's stem (AD 2601 Q116's "(c)/(d)" row).
                    continue  # keep scanning past the spill
                if len(ws) >= 3:
                    stem_idx = k  # the missing question's stem, sitting just after the spill
                break  # stop at the first non-option line
            if not stem_idx:  # None, or 0 (no leading option spill) → not this pattern; leave unchanged
                continue
            tail_labels = sum(1 for ln in lines[stem_idx:] for w in ln.words if _tok.is_option_label(w.text))
            if tail_labels < 3:
                continue  # the missing question must carry its OWN complete option block
            start = lines[stem_idx]
            pobj.markers.append(Marker(num=va + 1, x0=colb.left, y0=start.y0,
                                       x1=colb.left + mh, y1=start.y1, punct="gap"))
            pobj.markers.sort(key=lambda x: x.y0)


def _detect_page_frame(pages):
    """Per-page (top_y, bot_y, left_x, right_x) of the CROSS-PAGE-STABLE page FRAME (the institute box rule
    lines), as a dict keyed by 1-based page index; a page absent from the dict has no detected frame.

    Frames are detected PER RESOLUTION GROUP (same (width,height)). A single upload can concatenate papers
    rendered at different DPIs (e.g. 1337×1891 + 3490×4936); a frame y/x measured on one is meaningless on
    the other, and a SINGLE median across the mix produced a bottom-rule from the SHORT pages that then
    clipped the TALL pages' crops to nothing. Within a group the rule spans nearly the full width/height and
    repeats on most pages, so the median over ≥half the group isolates the frame — universal, no per-PDF
    constant. cv2-guarded; never raises. (Word boxes and renders share one pixel space, so no scaling.)"""
    try:
        import base64 as _b64

        import cv2  # type: ignore
        import numpy as _np  # type: ignore
    except Exception:  # noqa: BLE001
        return {}
    from collections import defaultdict as _dd

    groups = _dd(list)
    for p in pages:
        if p.image_base64:
            groups[(round(p.width), round(p.height))].append(p)

    out = {}
    for _key, grp in groups.items():
        tops, bots, lefts, rights = [], [], [], []
        for p in grp:
            try:
                img = cv2.imdecode(_np.frombuffer(_b64.b64decode(p.image_base64), dtype=_np.uint8), cv2.IMREAD_GRAYSCALE)
                if img is None:
                    continue
                H, W = img.shape[:2]
                dark = img < 140
                rfrac = dark.mean(axis=1)  # per-row ink (a horizontal rule spans ~full width)
                cfrac = dark.mean(axis=0)  # per-col ink (a vertical rule spans ~full height)
                up = [y for y in range(int(0.32 * H)) if rfrac[y] > 0.8]
                lo = [y for y in range(int(0.68 * H), H) if rfrac[y] > 0.8]
                le = [x for x in range(int(0.12 * W)) if cfrac[x] > 0.55]
                ri = [x for x in range(int(0.88 * W), W) if cfrac[x] > 0.55]
                if up:
                    tops.append(min(up))
                if lo:
                    bots.append(max(lo))
                if le:
                    lefts.append(min(le))   # the outer LEFT frame rule
                if ri:
                    rights.append(max(ri))  # the outer RIGHT frame rule (gutter divider is mid-page, excluded)
            except Exception:  # noqa: BLE001
                continue
        need = max(2, len(grp) // 2)
        med = lambda L: (sorted(L)[len(L) // 2] if len(L) >= need else None)  # noqa: E731
        gt, gb, gl, gr = med(tops), med(bots), med(lefts), med(rights)
        if gt is None and gb is None and gl is None and gr is None:
            continue
        for p in grp:
            out[p.index] = (gt, gb, gl, gr)
    return out


def _tighten_bands_to_frame(pages, bands, frames_by_page):
    """Pull each page's (header_bottom, footer_top) chrome band IN to just past THAT page's FRAME horizontal
    rule lines (per-page, resolution-correct). chrome_bands is token-based so it stops at the header/footer
    TEXT and leaves the drawn rule just inside content, where it lands at the top/bottom EDGE of a crop."""
    out = {}
    for pi, band in bands.items():
        hb, ft = band
        frame = frames_by_page.get(pi)
        if frame:
            top, bot, _l, _r = frame
            if top is not None:
                hb = max(hb, float(top) + 3.0)
            if bot is not None:
                ft = (float(bot) - 3.0) if (not ft or ft <= 0) else min(ft, float(bot) - 3.0)
        out[pi] = (hb, ft)
    return out


def _analyze(doc: DocumentInput, reocr: bool = False) -> DocumentAnalysis:
    # 0) RAPIDOCR RE-OCR (OCR ENGINE SELECTION) — on a SCANNED paper the platform OCR (Tesseract) drops half
    #    the question numbers AND many option labels, so the engine has nothing to own (10 of 20 on the
    #    reference scan). When the document was classified SCANNED upstream (reocr=True, per-request) and page
    #    renders are present, re-OCR every page with RapidOCR and REPLACE its words (18-19 of 20 on the same
    #    scan) — the rest of the pipeline is UNCHANGED, it just runs on the better token stream. A DIGITAL
    #    document keeps its platform tokens. `reocr` comes from the Node classifier; the STRUCTURE_RAPIDOCR
    #    env is only a manual/dev override.
    import os as _os_ro
    if reocr or _os_ro.environ.get("STRUCTURE_RAPIDOCR", "0").lower() in ("1", "true", "yes", "on"):
        try:
            from .rapid_reocr import reocr_pages
            reocr_pages(doc.pages)
        except Exception:  # noqa: BLE001 — re-OCR is best-effort; never break the document
            pass

    # 1) per-page structural metrics (dynamic — derived from each page's own geometry)
    metrics_by_page: Dict[int, PageMetrics] = {p.index: compute_metrics(p) for p in doc.pages}

    # 1.0) PIXEL geometry refinements (computed ONCE here, reused for crop bands below):
    #   • pixel chrome bands — the IMAGE header/footer (institute logo, banner, scan border) the token
    #     detector is blind to;
    #   • pixel column recovery — a 2-column page whose sparse/noisy scan OCR made the token detector
    #     collapse it to ONE column (which made every crop span BOTH columns — the full-page crop). The
    #     gutter is read from the page pixels, immune to OCR quality. Both are document-derived, not
    #     PDF-specific, and best-effort (no render / no CV stack ⇒ no change).
    from .chrome_pixels import pixel_chrome_bands
    from .column_pixels import refine_columns

    pixel_bands = pixel_chrome_bands(doc.pages)
    refine_split_pages = set()  # pages where the pixel refiner ADDED a column (1 → 2) — validated below
    for _p in doc.pages:
        _m = metrics_by_page[_p.index]
        _pre = len(_m.columns)
        _m.columns = refine_columns(_p, _m.columns, pixel_bands.get(_p.index))
        if len(_m.columns) > _pre:
            refine_split_pages.add(_p.index)

    # 1a) repeated header/footer/page-number chrome — detected across ALL pages so it can never
    #     become a false question marker / false ownership. KEEP-PIXELS; only excludes from markers.
    chrome = detect_chrome(doc.pages)

    # 1a.1) TAG chrome words so every structural consumer downstream (option detector, segment
    #        builder, pre-delivery search) skips them without needing the set threaded through.
    #        `word.chrome = True` is checked by find_option_lines; other consumers can add the
    #        check too (KEEP-PIXELS — the word stays in the list for line-geometry purposes).
    for _p in doc.pages:
        _chrome_keys = chrome.get(_p.index, set())
        if _chrome_keys:
            for _w in _p.words:
                if (round(_w.x0), round(_w.y0)) in _chrome_keys:
                    _w.chrome = True

    # 1b) derive question-number markers from the word tokens when TS didn't supply them
    #     (token parsing, not OCR). This is what lets Python segment INDEPENDENTLY of TS.
    for p in doc.pages:
        if not p.markers:
            p.markers = extract_markers(p.words, metrics_by_page[p.index], exclude=chrome.get(p.index, set()))

    # 1b.1) VALIDATE a PIXEL-refined column split against the MARKERS. refine_columns splits a 1-column page
    #       into two when it finds a central pixel gutter — but a 2-up OPTION grid (A|B / C|D, e.g. PHYCHE)
    #       has that same central gutter while the question NUMBERS all sit in the LEFT half. Cropping such a
    #       false split to its column then clips B/D + the right half of the stem (the "shows a,b + half the
    #       question" bug). A REAL 2-column page (AD/AIOTS) carries its OWN question markers in EACH column,
    #       so if a refine-split column has NO marker the split is spurious — revert that page to a single
    #       full-width column. Marker-based + scoped to refine-split pages only, so a genuine 2-column page
    #       (or a token-detected one) is never collapsed.
    for p in doc.pages:
        if p.index not in refine_split_pages:
            continue
        m = metrics_by_page[p.index]
        if len(m.columns) < 2 or not p.markers:
            continue
        cols_with_markers = {m.column_of((mk.x0 + mk.x1) / 2.0) for mk in p.markers}
        if len(cols_with_markers) < len(m.columns):
            # KEEP the split when a markerless column still carries QUESTION TEXT — a REAL 2-column page
            # whose right-column numbers the OCR missed (binding the left+right questions into one wide crop
            # if collapsed). Revert ONLY when no markerless column has stem text (a true 2-up option grid).
            _unused = [ci for ci, _c in enumerate(m.columns) if ci not in cols_with_markers]
            if any(_col_has_question_text(p, m.columns[ci], m.line_tol) for ci in _unused):
                continue
            from .geometry import Column as _Col
            left = min(c.left for c in m.columns)
            right = max(c.right for c in m.columns)
            m.columns = [_Col(left=left, right=right)]

    # 1c) CV BADGE markers (analyze mode) — a question number printed inside a dark SEAL/badge is
    #     white-on-black, so the OCR read NOTHING (`OCR=NO`) and the token markers miss it: the question
    #     goes MISSING and its neighbours MERGE into one crop. When the page RENDER is supplied, detect the
    #     seal on pixels and READ its true number by inversion (validated: a "132 NM" seal reads "132"),
    #     injecting a marker WITH that value so the count + ownership are correct. Unlike the numberless
    #     boundary marker, this carries the REAL number, so adjacent gaps (…119,120… / …153,154…) resolve
    #     correctly instead of relying on position inference. A plain-text page has no seals ⇒ no-op.
    _inject_badge_markers(doc.pages, metrics_by_page)

    # 2) page classification (role): only QUESTION pages feed question extraction
    page_classes = [classify_page(p, metrics_by_page[p.index]) for p in doc.pages]
    # 2.0) FULL-PAGE GRID exclusion — an answer-key / error-analysis / OMR / marks TABLE page is a
    #      multi-column grid whose numbered ROWS would otherwise be mined (or OCR-recovered) as questions
    #      (the q98/q99 "table row became a question" bug). Detect it from the page's rule lines and demote
    #      it out of the question set — universal, no keyword/PDF constant.
    grid_pages = _detect_grid_pages(doc.pages)
    if grid_pages:
        from .models import PageKind as _PK

        for pc in page_classes:
            if pc.index in grid_pages and pc.kind == _PK.QUESTION:
                pc.kind = _PK.APPENDIX
                pc.candidate = True
                pc.confidence = min(pc.confidence, 0.9)
                pc.reason = "grid_table_page"
    # 2.0c) ANSWER-KEY KEYWORD FALSE POSITIVE — correct pages mis-classified as ANSWER_KEY because an
    #        instruction line contained "answer sheet" / "answer key" while the page ALSO carries the
    #        opening questions of the paper (e.g. a cover page with Q1–Q4 at the bottom whose OMR note
    #        says "rough work must not be done on the answer sheet"). A genuine answer-key page does NOT
    #        start the document's question-number sequence; a cover/instruction page always does.
    #        Guard: only keyword-triggered candidates (pair-density keys are structurally clean); and the
    #        page's minimum marker must be ≤ doc_min + 1 (starts the sequence). Fires at most once per
    #        document (a paper never has two sequence-starting pages). TS still validates the proposal.
    _all_nums = sorted(mk.num for p in doc.pages for mk in p.markers if mk.num is not None and mk.num >= 1)
    _doc_min = _all_nums[0] if _all_nums else 1
    for _pc in page_classes:
        if _pc.kind != PageKind.ANSWER_KEY or not _pc.candidate:
            continue
        if "answer_key_keyword" not in _pc.reason:
            continue
        _pobj = next((p for p in doc.pages if p.index == _pc.index), None)
        if not _pobj:
            continue
        _mnums = sorted(mk.num for mk in _pobj.markers if mk.num is not None and mk.num >= 1)
        if not _mnums:
            continue
        if _mnums[0] <= _doc_min + 1:
            # This page carries the FIRST questions — the keyword is in the instructions, not in key data
            _pc.kind = PageKind.QUESTION
            _pc.candidate = False
            _pc.confidence = 0.80
            _pc.reason = f"overridden:sequence_start (was answer_key_keyword; min_marker={_mnums[0]})"

    qpage_indices = {pc.index for pc in page_classes if pc.kind == PageKind.QUESTION}
    qpages: List[PageInput] = [p for p in doc.pages if p.index in qpage_indices]

    # 2a) (handwritten-number RECOVERY moved DOWN to step 2c.5). Handwritten OCR is a recovery engine, not a
    #     detector — it must run AFTER question detection + sequence validation + gap detection, and ONLY where
    #     a gap actually exists, never as a blanket per-page margin scan before detection. See step 2c.5.

    # 2b) QUESTION COUNT AUTHORITY — reconcile the raw markers to the CANONICAL question
    #     markers (drop false starts: table/content/sub-list numbers) via margin anchoring +
    #     section-restart-safe sequence reconstruction, over the QUESTION pages only. This is
    #     what makes the logical count trustworthy; segmentation runs on reconciled markers.
    recon = reconcile_markers(qpages, metrics_by_page)
    for p in qpages:
        p.markers = recon.canonical_by_page.get(p.index, [])

    # 2b.1) RE-VALIDATE a PIXEL-refined column split against the RECONCILED (canonical) markers. The raw-
    #       marker check at step 1b.1 is fooled by a CONTENT number that looks like a question start in the
    #       option half — a 2-up grid's right column carries strings like "3-carboxypentane-1,5-dioic acid",
    #       whose stray "1"/"5" extract as col1 markers, so 1b.1 sees a marker in BOTH columns and keeps the
    #       false split. The RECONCILER drops those off-sequence numbers, so here (canonical markers) a refine-
    #       split column with NO real question marker is confirmed spurious and the page is reverted to ONE
    #       full-width column — BEFORE segmentation/ownership, so the right-hand B,D options are never handed
    #       to a cross-column neighbour (PHYCHE Q36/37 "only A,C cropped" bug). A genuine 2-column page carries
    #       canonical markers in EACH column and is never collapsed.
    # DOCUMENT-LEVEL single-column gate: the page-level 2-up override below applies ONLY when the WHOLE paper
    # is single-column (NO page has a real 2-column marker structure). A 2-column paper (AD/AIOTS/25REP/RE
    # NEET) — even one with a lone page that happens to look single-column-2up (AIOTS p19) — is excluded, so
    # the multi-column path is never affected. This is the "handle single-column LAYOUT separately" gate.
    _doc_single_column = not any(
        _page_is_two_column(p, metrics_by_page[p.index].char_w) for p in qpages if p.markers
    )
    from .geometry import Column as _Col_2b1
    for p in qpages:
        _m2 = metrics_by_page[p.index]
        if len(_m2.columns) < 2 or not p.markers:
            continue
        # A single-column doc's 2-up OPTION grid page. Fires for a page the PIXEL refiner split (existing) OR
        # — new — a page the TOKEN detector itself split at a CLEAR option gutter (Biology_Cell p16: the option
        # columns leave a real whitespace gutter, so `detect_columns` finds it and the page is NOT in
        # refine_split_pages, yet its B/D options still get cut). The document-level gate keeps BOTH cases OFF
        # every multi-column paper, so that path is untouched.
        _sc2up = _doc_single_column and _is_single_column_2up(p, _m2)
        if p.index not in refine_split_pages and not _sc2up:
            continue
        _cwm = {_m2.column_of((mk.x0 + mk.x1) / 2.0) for mk in p.markers}
        if len(_cwm) < len(_m2.columns):
            _unused2 = [ci for ci, _c in enumerate(_m2.columns) if ci not in _cwm]
            if any(_col_has_question_text(p, _m2.columns[ci], _m2.line_tol) for ci in _unused2) and not _sc2up:
                continue  # markerless column has real question text -> genuine 2-column (unread numbers), KEEP
            # else: SINGLE-column doc's 2-up grid whose full-width explanation prose fooled the text check -> revert
            _m2.columns = [_Col_2b1(left=min(c.left for c in _m2.columns),
                                    right=max(c.right for c in _m2.columns))]

    # 2b.2) MARKER-DRIVEN COLUMN CORRECTION — the question MARKERS are the ground truth for columns: each
    #       column's questions all start at that column's left margin. When the pixel/token gutter lands in
    #       the WRONG place (a cover page's full-width instruction boxes + a diagonal watermark skew it — RE
    #       NEET page 1: gutter found at x780 while the real columns start at x37 and x621), TWO marker x-
    #       clusters fall inside ONE detected column and its questions crop full-width (binding left+right).
    #       If the canonical markers form >=2 well-separated x-clusters (each a real column with >=2 questions)
    #       that the current columns DON'T separate, rebuild the columns from the clusters: each cluster's
    #       left is a column margin, the boundary sits just left of the next cluster. Universal (driven by the
    #       document's own markers); conservative (>=2 clusters, >=2 markers each, only when not already split).
    from collections import Counter as _Counter_mc
    from .geometry import Column as _Col_mc
    for p in qpages:
        m = metrics_by_page[p.index]
        _mxs = sorted(mk.x0 for mk in p.markers if mk.num is not None)
        if len(_mxs) < 4:
            continue
        _cwm2 = max(6.0, float(getattr(m, "char_w", 0) or 8.0))
        _clusters = [[_mxs[0]]]
        for _x in _mxs[1:]:
            (_clusters[-1].append(_x) if (_x - _clusters[-1][-1]) <= 8.0 * _cwm2 else _clusters.append([_x]))
        _big = [c for c in _clusters if len(c) >= 2]            # a real column has >=2 question starts
        if len(_big) < 2:
            continue
        _lefts = sorted(min(c) for c in _big)
        _hit = {m.column_of(lf) for lf in _lefts}
        if len(_hit) >= len(_lefts):
            continue  # clusters already land in distinct columns -> geometry is correct, leave it
        _pright = max((c.right for c in m.columns), default=max((w.x1 for w in p.words), default=_lefts[-1] + 100))
        m.columns = [
            _Col_mc(left=max(0.0, lf - _cwm2), right=(_lefts[i + 1] - _cwm2) if i + 1 < len(_lefts) else _pright)
            for i, lf in enumerate(_lefts)
        ]

    # 2c) STRUCTURAL GAP-FILL — recover a question whose printed NUMBER was too faint for OCR but whose
    #     CONTENT (stem + options) IS present. When exactly ONE number N is missing between two accepted,
    #     reading-order-adjacent markers (N-1 then N+1) and a question-shaped block sits between them, the
    #     block IS question N: synthesize a marker for it (value from the sequence) so the normal
    #     segmentation/crop pipeline delivers its crop. No OCR, no TS, no PDF constant — the content is
    #     already in the tokens. Conservative (single gaps, clear paragraph boundary, real content on both
    #     sides) so it never invents a question where there is only one question's content.
    # the count Tesseract (platform OCR) actually established for the runtime log, BEFORE any handwritten
    # recovery — so the log can show Expected vs Tesseract vs Recovered honestly.
    _tesseract_nums = sorted({mk.num for p in qpages for mk in p.markers if mk.num is not None})
    _fill_sequence_gaps(qpages, metrics_by_page)

    # 2c.5) HANDWRITTEN-NUMBER RECOVERY (gap-driven, recovery-only). NOW that detection + reconcile + token
    #     gap-fill have established the sequence, run handwritten OCR ONLY where a numbering gap remains, and
    #     ONLY inside the small region between the two bounding questions — never a whole page, never an
    #     already-detected question. Each recovered number must pass sequence + layout + ownership continuity
    #     before it is promoted. Master-gated by STRUCTURE_NUMBER_OCR (default OFF); a true no-op when the
    #     numbering is already contiguous (regions == 0). Returns stats for the runtime log below.
    _hw_stats = _recover_missing_numbers_handwritten(qpages, metrics_by_page)

    # 2d) FIGURE REGIONS (page pixels) — detect the non-text DRAWINGS (diagram / graph / chem-structure /
    #     circuit) on each question page so the rest of the pipeline is figure-aware. A figure is found by
    #     its STROKES after the OCR words are subtracted, so a diagram that CARRIES letter labels ("A","C")
    #     is still detected (its labels removed, its line-art defines the box). Two uses: (a) the option
    #     detector REJECTS a label that sits inside a figure (so a diagram's point labels never become
    #     phantom MCQ options), and (b) the figure is OWNED by its question so the crop is never sliced
    #     through it. Near-no-op on a pure-text paper (no drawing ⇒ no region). cv2-guarded; best-effort.
    frames_by_page = _detect_page_frame(doc.pages)  # {pi: (top, bot, left, right)}, per resolution group
    from .figure_regions import assign_figures_to_questions, detect_figure_regions

    figures_by_page: Dict[int, list] = {}
    for p in qpages:
        figs = detect_figure_regions(p, metrics_by_page[p.index].median_h, frames_by_page.get(p.index))
        if figs:
            figures_by_page[p.index] = figs

    # 2d.1) PROTECT figure-interior words — tag every word whose centre sits inside a detected figure as
    #        `word.protected = True`. Protected words are KEPT (KEEP PIXELS; they render in the crop and
    #        their text is visible) but SKIPPED by every structural consumer that runs AFTER this point:
    #        option detection (find_option_lines), column geometry (detect_columns re-run), and any future
    #        consumer — without threading figure_boxes as a parameter. A diagram label ("A","C","B","x²")
    #        is visual, not structural; it must never become an MCQ option or a column boundary.
    #        Note: markers were already extracted in step 1b (before figure detection), so this tagging does
    #        not retroactively protect them — but the num<1 guard in extract_markers already handles the
    #        circuit-label / binary-digit case. This tagging is effective for steps 3–6 (segmentation,
    #        option detection, crop planning) which all run AFTER this point.
    if figures_by_page:
        from .figure_regions import tag_protected_words
        for p in qpages:
            figs = figures_by_page.get(p.index)
            if figs:
                tag_protected_words(p.words, figs)

    # 2d.2) EVIDENCE-BASED GAP RECOVERY — recover a question whose NUMBER the OCR never read, but ONLY where
    #        the detected number SEQUENCE has a hole. A complete option block (a stem + a full option set at
    #        the column margin) with no marker is a candidate; it is accepted only when its reading-order
    #        position lands on a MISSING number (an internal gap, or the run before the first number down to
    #        1). A fully-numbered paper has no gap → no recovery. Driven by sequence validation + ownership.
    #        Runs AFTER figure detection (diagram labels excluded) and BEFORE segmentation. Never raises.
    #
    #        OCR-AGNOSTIC: recovery is an OWNERSHIP capability, not an OCR-engine one — it runs identically on
    #        Tesseract, RapidOCR or any future tokens. It currently recovers only the NON-INTERFERING boundary
    #        case (a question before the first detected number, e.g. an unread "1." — it is ADDED above all
    #        existing questions and so cannot re-bound any of them). INTERNAL-gap recovery is disabled inside
    #        recover_gap_questions because marker injection between two markers re-bounds the previous question
    #        and a false candidate splits a real one (the AD regression); the safe internal path is a
    #        post-process SPLIT of an already-merged question, built separately. Every recovered question is
    #        ownership-validated (dropped after plan_crops unless it yields a real crop) like any normal one.
    from .structural_question_detector import recover_gap_questions
    _recovered = recover_gap_questions(qpages, metrics_by_page, figures_by_page)
    if _recovered:
        import sys as _sys_gr
        print(f"[gap-recovery] injected {_recovered} question(s) at sequence gaps", file=_sys_gr.stderr)

    # 3) start + end (segment) detection per question page
    segments_by_page: Dict[int, list] = {}
    for p in qpages:
        m = metrics_by_page[p.index]
        starts = detect_starts(p, m)
        segments_by_page[p.index] = compute_segments(p, m, starts)

    # 4) merge detection (continuation + cross-column + cross-page) → question groups
    groups = build_groups(qpages, metrics_by_page, segments_by_page)

    # 5) ownership graph → question candidates + orphans (every element gets one owner)
    questions, orphans = build_questions(groups, qpages, metrics_by_page, figures_by_page)

    # 5.0) FIRST-ON-PAGE — tag each question that is the first to START on its start_page.
    #       "First on page" = smallest y0 among all questions whose start_page equals this page.
    #       Used by the ownership validator (validation report) and exposed to TS via firstOnPage.
    #       A cross-page question's start_page is where its NUMBER MARKER is (not where its options
    #       land), so Q7 that starts on page N and flows to page N+1 is "first on page N", not N+1.
    _best_by_page: Dict[int, tuple] = {}  # page → (y0, question)
    for _q in questions:
        _pg = _q.start_page
        _qy = float(_q.number_box[2]) if _q.number_box else (_q.boxes[0].y0 if _q.boxes else float('inf'))
        if _pg not in _best_by_page or _qy < _best_by_page[_pg][0]:
            _best_by_page[_pg] = (_qy, _q)
    for _q in questions:
        _q.first_on_page = (_best_by_page.get(_q.start_page, (None, None))[1] is _q)

    # 5a) OWN each detected figure to the question whose column-slab encloses it, as a DIAGRAM box. The crop
    #     planner already honours owned visual boxes (extends the crop through them, never trims them), so a
    #     diagram / graph / circuit is delivered WHOLE with its question instead of being cut at a false
    #     option. A figure inside no slab is left unowned (never forced onto the wrong question).
    assign_figures_to_questions(questions, figures_by_page, metrics_by_page,
                                pages_by_index={p.index: p for p in doc.pages})

    # 5b) VISUAL ELEMENT detection + attachment (token layer): a figure/diagram (word-free
    #     band), a table (word grid) or an equation (math-symbol line) inside a question's owned
    #     span belongs to that question. Sets per-question `visuals` for the completeness gate.
    words_by_page = {p.index: p.words for p in qpages}
    for q in questions:
        qwords = []
        for b in q.boxes:
            for w in words_by_page.get(b.page, []):
                if b.x0 - 2 <= w.cx <= b.x1 + 2 and b.y0 - 2 <= w.cy <= b.y1 + 2:
                    qwords.append(w)
        region = (q.boxes[0].x0, q.boxes[0].y0, q.boxes[-1].x1, q.boxes[-1].y1) if q.boxes else (0, 0, 0, 0)
        m = metrics_by_page.get(q.start_page) or next(iter(metrics_by_page.values()))
        q.visuals = classify_question_visuals(qwords, region, m)
        if q.visuals.get("diagram") == "PASS":
            q.has_diagram = True

    # 6) sequence validation (duplicate / zero / impossible). Reconciler duplicates are surfaced
    #    even when the reconciler itself demoted one copy (so anomalies are never silently dropped).
    sequence = validate_sequence(questions)
    sequence.duplicates = sorted(set(sequence.duplicates) | set(recon.duplicates))
    sequence.question_zero = sequence.question_zero or recon.question_zero

    analysis = DocumentAnalysis(
        document_id=doc.document_id,
        schema_version=SCHEMA_VERSION,
        page_classes=page_classes,
        questions=questions,
        orphans=orphans,
        sequence=sequence,
        promotion=promotion_registry(),
    )

    # 6b) infer the paper's DOMINANT option count (never hardcoded) — so '3 of 4 found' is flagged
    #     for cross-column/page search instead of being marked complete.
    expected_options = crop_completeness_validator.infer_expected_options(questions)

    # 6b.1) OWNERSHIP VALIDATION — the primary gate before crop construction.
    #        Architecture: ownership graph → ownership freeze → [HERE] → crop build → validate → neighbor leak
    #        Validates 7 dimensions per question: owner, cross-page, cross-column, protected-region,
    #        options, solution, next-question-safe. Fatal failures (no owner; text overflow past the
    #        next question's marker that cannot be repaired) set crop_allowed=False → plan_crops skips
    #        those questions entirely. Advisory failures (options, protected-region) flag for review
    #        but do not block crop construction. Repair: TEXT boxes that start past the next marker are
    #        removed from q.boxes before the question is declared unrecoverable (KEEP PIXELS: diagrams
    #        are never removed; the crop planner's slab_bottom handles their visual clipping).
    #        "Page boundaries and column boundaries are NOT separators — only the next owner is."
    _pages_by_index_early = {p.index: p for p in doc.pages}
    from .ownership_validator import validate_ownership
    _ov = validate_ownership(questions, metrics_by_page, expected_options, _pages_by_index_early)
    if _ov["blocked"] or _ov["repaired"]:
        analysis.notes.append(
            f"ownership_validation:checked={_ov['checked']}"
            f",blocked={_ov['blocked']},repaired={_ov['repaired']}"
        )

    # 6c) CROP INSTRUCTIONS — Python OWNS the crop boundary. Compute the exact crop rectangle(s) per
    #     question (union of owned boxes + options + number + visuals, clipped to the page chrome band,
    #     padded engine-side, clamped to page bounds) so TS executes them verbatim and never does
    #     boundary math. Same pixel space as the OCR words TS sent. (one question = one owner = one crop)
    # 6c.0) COLUMN-SPLIT VALIDATION against the FINAL question set (authoritative — false markers already
    #       dropped by the reconciler). A 1-column page with a 2-up OPTION grid (A|B / C|D) gets split into
    #       two — by the pixel refiner OR by the TOKEN detector itself (the option gutter reads as a column
    #       boundary, e.g. Biology cols [(29,532),(602,1058)]). Cropping to such a false column clips B/D +
    #       the right half of the stem. Discriminator: a REAL 2-column page carries its OWN question numbers
    #       in EACH column; a false split has every question's number in ONE column (the options just spill
    #       into the other). So for EVERY page with >=2 columns, if a column holds NO final question, revert
    #       it to ONE full-width column. Genuine 2-column papers (AD/AIOTS) keep questions in both columns
    #       and are never collapsed.
    from .geometry import Column as _Col2, group_lines
    _pages_by_idx_cc = {p.index: p for p in doc.pages}
    q_centers_by_page: Dict[int, List[float]] = {}
    for _q in questions:
        nb = _q.number_box
        if nb:
            q_centers_by_page.setdefault(int(nb[0]), []).append((float(nb[1]) + float(nb[3])) / 2.0)
        elif _q.boxes:
            b0 = _q.boxes[0]
            q_centers_by_page.setdefault(int(b0.page), []).append((b0.x0 + b0.x1) / 2.0)
    for _pi, _m in list(metrics_by_page.items()):
        if not _m or len(_m.columns) < 2:
            continue
        centers = q_centers_by_page.get(_pi, [])
        if not centers:
            continue  # no questions on this page -> leave its geometry untouched
        cols_used = {_m.column_of(cx) for cx in centers}
        if len(cols_used) >= len(_m.columns):
            continue
        # CONTENT GUARD before collapsing: a column with no DETECTED question may still be a REAL text
        # column whose question's NUMBER was simply unread — the first question on the page is the common
        # case (its 'N.' missed, so it has no number_box and its column is taken from a stray first box that
        # can fall in the OTHER column). Collapsing then makes EVERY crop on the page span both columns (the
        # 'two questions in one crop' bug). A genuine 2-up OPTION grid (A|B / C|D) — the case this collapse
        # is FOR — has only OPTION LABELS in the spill column (the B/D of each row), never independent
        # question PROSE. So count only multi-word lines whose first token is NOT an option label: a long 2-up
        # option ("B) 3-carboxypentane-1,5-dioic acid") is multi-word but starts with an option label, so it
        # is excluded — that was the bug where a long-option grid (PHYCHE) was mistaken for a real column and
        # the right-hand B,D fell to a cross-column neighbour. A real second column carries STEM lines (start
        # with a word/number, not a label); >=2 of those ⇒ genuine column, KEEP the split.
        from . import tokens as _tok_cc
        def _is_stem_line(_ln):
            _ws = sorted(_ln.words, key=lambda w: w.x0)
            return len(_ws) >= 3 and not (_ws and _tok_cc.is_option_label(_ws[0].text))
        _pg_cc = _pages_by_idx_cc.get(_pi)
        _real_unused_col = False
        if _pg_cc:
            for _ci, _col in enumerate(_m.columns):
                if _ci in cols_used:
                    continue
                _cwords = [w for w in _pg_cc.words
                           if _col.left - 0.5 <= w.cx <= _col.right + 0.5 and not getattr(w, "chrome", False)]
                if sum(1 for ln in group_lines(_cwords, _m.line_tol) if _is_stem_line(ln)) >= 2:
                    _real_unused_col = True
                    break
        if _real_unused_col:
            continue  # genuine 2-column page with an unread number in one column -> never collapse
        _m.columns = [_Col2(left=min(c.left for c in _m.columns), right=max(c.right for c in _m.columns))]

    # frames_by_page computed once in step 2d (per resolution group) and reused here for the crop clamp.
    # Chrome bands fed to the crop planner = token bands (word chrome) MERGED with PIXEL bands (image
    # logo / banner / scan border the tokens are blind to), then tightened to the page frame rule lines.
    # This is what removes the institute footer ('THE SK LEARNINGS') / header from every delivered crop,
    # universally — it is derived from cross-page pixel stability, never a per-PDF constant.
    from .chrome_pixels import merge_bands

    token_bands = chrome_bands(doc.pages, chrome)
    page_heights = {p.index: p.height for p in doc.pages}
    merged_bands = merge_bands(token_bands, pixel_bands, page_heights)  # pixel_bands from step 1.0
    crop_bands = _tighten_bands_to_frame(doc.pages, merged_bands, frames_by_page)
    frame_x_by_page = {pi: (f[2], f[3]) for pi, f in frames_by_page.items()}
    pages_by_index = {p.index: p for p in doc.pages}
    plan_crops(questions, pages_by_index, crop_bands, expected_options, metrics_by_page,
               frame_x_by_page=frame_x_by_page)

    # 6c.0b) OWNERSHIP VALIDATION of GAP-RECOVERED questions — a question injected by evidence-based gap
    #        recovery (its number was OCR-unread) is KEPT only when ownership/crop construction validates it
    #        as a real, croppable question (a genuine crop region). One that produced NO crop region was a
    #        false candidate (a numeric block that was not actually a new question) — drop it so it never
    #        inflates the logical count. DETECTED (numbered-by-OCR) questions are never dropped here; only
    #        recovered ones are subject to this gate. This is the "driven by ownership validation" rule.
    _pre_rec = len(questions)
    questions = [q for q in questions if (not q.recovered) or q.crop_regions]
    if len(questions) != _pre_rec:
        analysis.questions = questions
        analysis.notes.append(f"gap_recovery_unvalidated_dropped:{_pre_rec - len(questions)}")

    # 6c.1) NEIGHBOR LEAK VALIDATION + AUTO-REPAIR — safety net after plan_crops. The ownership freeze
    #        in the crop planner (slab_bottom re-enforcement) is the primary guard; this pass is the
    #        secondary check. It scans every crop for OTHER questions' markers, auto-repairs by truncating
    #        at the earliest leaked marker (never silently deliver a crop containing two questions), and
    #        flags the question with neighbor_leak=True + review_reasons=["neighbor_leak"]. A crop with
    #        zero leaks after repair routes normally; a crop that cannot be repaired (truncate_y ≤ ry0)
    #        is flagged for review — TS decides, Python never delivers silently.
    from .crop_planner import validate_neighbor_leaks
    _leak_count = validate_neighbor_leaks(questions, metrics_by_page)
    if _leak_count:
        analysis.notes.append(f"neighbor_leaks_repaired:{_leak_count}")

    # 6c.1b) PRE-DELIVERY VALIDATION — the SINGLE AUTHORITY before TS finalizes a crop.
    #         For any question with an incomplete option set it ACTIVELY SEARCHES slab →
    #         cross-column → cross-page (stopping only at a real next owner; badge_guard
    #         rejects decorative numbers as boundaries) to RECOVER the missing options
    #         before judging completeness. A crop is deliverable only when it is complete
    #         (number+stem+full option set OR a visual stand-in), ownership-valid,
    #         crop-valid and leak-free; otherwise the question is routed to review — never
    #         delivered with 2 of 4. Sets q.deliverable / q.delivery_report; the doc gate
    #         goes to analysis.delivery_gate. Python decides; TS renders (no pixels here).
    from .pre_delivery_validator import validate_pre_delivery
    _pd = validate_pre_delivery(questions, metrics_by_page, expected_options, pages_by_index)
    analysis.delivery_gate = _pd["gate"]
    if _pd["searched"] or _pd["blocked"]:
        analysis.notes.append(
            f"pre_delivery:checked={_pd['checked']},searched={_pd['searched']}"
            f",recovered={_pd['recovered']},blocked={_pd['blocked']},gate={_pd['gate']}"
        )

    # 6c.2) PER-QUESTION VALIDATION REPORT — Problem 8 (never silently deliver incorrect output).
    #        Printed to stderr so it appears in server logs without bloating the API response.
    #        Columns: Q | page | owner | qtext | opts | diag | graph | tbl | eq | chem |
    #                 xpage | xcol | leak | cropOK | ownOK | RESULT
    import sys as _sys  # noqa: PLC0415 — scoped import keeps this diagnostic block self-contained
    _VK_REPORT = {ElementKind.DIAGRAM, ElementKind.GRAPH, ElementKind.TABLE,
                  ElementKind.EQUATION, ElementKind.CHEM_STRUCTURE}
    _hdr = ("Q    pg  owner  qtext  opts diag grph tbl  eq  chem  "
            "xpg  xcol leak cropOK ownOK  RESULT")
    _lines = [_hdr, "-" * len(_hdr)]
    for _q in questions:
        _diag = sum(1 for b in _q.boxes if b.kind == ElementKind.DIAGRAM)
        _grph = sum(1 for b in _q.boxes if b.kind == ElementKind.GRAPH)
        _tbl  = sum(1 for b in _q.boxes if b.kind == ElementKind.TABLE)
        _eq   = sum(1 for b in _q.boxes if b.kind == ElementKind.EQUATION)
        _chem = sum(1 for b in _q.boxes if b.kind == ElementKind.CHEM_STRUCTURE)
        _has_text = any(b.kind not in _VK_REPORT for b in _q.boxes) or bool(_q.number_box)
        _owner_ok = _q.crop_allowed
        _crop_ok  = _q.crop_valid
        _result   = "PASS" if (_crop_ok and _owner_ok and not _q.neighbor_leak) else "FAIL"
        _lines.append(
            f"{str(_q.number or '?'):<4} {_q.start_page:<3} "
            f"{'YES' if _q.number_box else 'NO ':<6} "
            f"{'YES' if _has_text else 'NO ':<6} "
            f"{_q.option_count:<4} {_diag:<4} {_grph:<4} {_tbl:<4} {_eq:<3} {_chem:<4}  "
            f"{'Y' if _q.multi_page else 'N':<4} "
            f"{'Y' if _q.multi_column else 'N':<4} "
            f"{'Y' if _q.neighbor_leak else 'N':<4} "
            f"{'PASS' if _crop_ok else 'FAIL':<6} "
            f"{'PASS' if _owner_ok else 'FAIL':<6} "
            f"{_result}"
        )
    _fail_count = sum(1 for ln in _lines[2:] if ln.endswith("FAIL"))
    _lines.append(f"\n[crop-report] {len(questions)} questions | {_fail_count} FAIL")
    print("\n".join(_lines), file=_sys.stderr)

    # 7) completeness + ANOMALY-based review routing (never silently deliver wrong output)
    review_router.route(questions, sequence, expected_options)

    # 8) confidence scoring (advisory) — uses the anomaly review flags above
    for q in questions:
        q.confidence = confidence_engine.score_question(q)

    # 8b) confidence TIERS (constraint #4): assign AUTO_ACCEPT/VERIFY/REVIEW; a REVIEW tier
    #     (confidence < 80) routes to review so uncertain ownership is never delivered.
    for q in questions:
        q.confidence_pct, q.tier = confidence_engine.assign_tier(q)
        if q.tier == "REVIEW" and not q.needs_review:
            q.needs_review = True
            q.review_reasons = sorted(set(q.review_reasons + [f"low_confidence:{q.confidence_pct}"]))

    # 9) internal consistency + recommendation (advisory; TS still validates)
    validator.finalize(analysis)

    # 10) ownership + N=N=C integrity gate (constraints #2/#3) — STOP ⇒ recommend REVIEW
    analysis.integrity = compute_integrity(analysis)
    if analysis.integrity.get("status") == "STOP":
        analysis.recommendation = "REVIEW"

    analysis.confidence = confidence_engine.score_document(analysis)

    # 10b) OWNERSHIP COMPLETENESS GATE (mandatory BEFORE any crop build). Per-question heatmap
    #      (completeness / missing / detached / conflicts) + a document cropGate. Crop construction
    #      is permitted ONLY when cropGate == PASS (every question complete, no conflicts/detached,
    #      integrity PASS); otherwise repair/recompute, REVIEW last. TS must NOT persist until PASS.
    heatmap, crop_gate = build_heatmap(analysis.to_dict(), expected_options)
    analysis.ownership_heatmap = heatmap
    analysis.crop_gate = crop_gate

    # 10c) PRE-DELIVERY GATE is the SINGLE delivery authority — a question that the
    #      pre-delivery validator could not complete (even after active cross-column /
    #      cross-page option search) routes the WHOLE document to review. Never deliver a
    #      crop with a missing option / stem / visual.
    if analysis.delivery_gate != "PASS":
        analysis.recommendation = "REVIEW"

    # 11) QUESTION COUNT AUTHORITY report — the logical question count + anomalies. The count
    #     is the ownership-graph question count AFTER marker reconciliation (NOT crops, NOT OCR
    #     token count, NOT persisted rows). Anomalies surface every removed/odd marker.
    anomalies = []
    if sequence.duplicates:
        anomalies.append({"type": "duplicates", "values": sequence.duplicates})
    if sequence.question_zero:
        anomalies.append({"type": "question_zero"})
    if sequence.impossible:
        anomalies.append({"type": "impossible_sequence", "count": len(sequence.impossible)})
    if sequence.gaps:
        anomalies.append({"type": "missing_numbers", "values": sequence.gaps})
    if recon.restarts:
        anomalies.append({"type": "restarts", "count": recon.restarts})
    removed = recon.demoted_spurious + recon.demoted_offmargin
    if removed:
        anomalies.append({"type": "spurious_markers", "removed": removed})
    if recon.recovered:
        anomalies.append({"type": "recovered_questions", "values": recon.recovered})
    if recon.missing:
        # never silently skip — every missing number carries an explanation for review
        anomalies.append({
            "type": "missing_questions",
            "values": recon.missing,
            "explanation": "no marker candidate found at the question margin (OCR did not read the "
                           "number, or a numberless region) — routed to review, not skipped",
        })
    # EXPECTED count — the contiguous question-number range Python expects to exist (max-min+1).
    # The single delivery gate enforces Expected == Logical == Ownership == Crop == Delivered; when a
    # number is missing (a gap), Expected > Logical and the document routes to review, never delivers.
    _nums = sorted(q.number for q in questions if q.number)
    expected_count = (_nums[-1] - _nums[0] + 1) if _nums else len(questions)
    analysis.question_count = {
        "logicalQuestionCount": len(questions),
        "expectedCount": expected_count,
        "ownershipCount": int(analysis.integrity.get("nnc", {}).get("stage1", {}).get("ownershipCount", len(questions))),
        "completeQuestionCount": sum(1 for q in questions if q.complete and not q.needs_review),
        "cropValidCount": sum(1 for q in questions if q.crop_valid),
        "expectedOptionCount": expected_options,
        "recoveredQuestions": recon.recovered,
        "missingQuestions": recon.missing,
        "confidence": analysis.confidence,
        "anomalies": anomalies,
        "reconciled": {
            "accepted": recon.accepted,
            "offMargin": recon.demoted_offmargin,
            "spurious": recon.demoted_spurious,
            "restarts": recon.restarts,
        },
    }

    # RUNTIME LOG — handwritten OCR is a RECOVERY engine; surface exactly what it did. "regionsProcessed"
    # is 0 whenever the numbering had no gap (or recovery is disabled), so it is easy to confirm handwritten
    # OCR never ran over already-detected content. Attached to the proposal AND printed to the sidecar log.
    hw = _hw_stats if isinstance(_hw_stats, dict) else {}
    by_type = hw.get("byType", {})

    def _bt_counts(t):
        d = by_type.get(t, {})
        return {"regionsProcessed": d.get("regions", 0),
                "recovered": d.get("recovered", []),
                "rejected": len(d.get("rejected", []))}

    recovery_log = {
        "expectedQuestions": expected_count,
        "tesseractQuestions": len(_tesseract_nums),
        "missingQuestions": hw.get("gaps", []),
        "handwrittenOcrEnabled": hw.get("enabled", False),
        "handwrittenOcrExecuted": hw.get("regions", 0) > 0,
        "handwrittenOcrRegionsProcessed": hw.get("regions", 0),
        "recoveredQuestions": hw.get("recovered", []),
        "rejectedCandidates": hw.get("rejected", []),
        "gapTypes": {t: _bt_counts(t) for t in ("IN_COLUMN", "CROSS_COLUMN", "CROSS_PAGE")},
        "logicalQuestions": len(questions),
        "ownershipQuestions": analysis.question_count["ownershipCount"],
        "cropCount": analysis.question_count["cropValidCount"],
        "deliveredCount": analysis.question_count["cropValidCount"],  # Python proposal; TS gates final delivery
    }
    analysis.question_count["handwrittenRecovery"] = recovery_log
    try:
        gt = recovery_log["gapTypes"]
        print(
            "[handwritten-recovery] "
            f"Expected={recovery_log['expectedQuestions']} "
            f"Tesseract={recovery_log['tesseractQuestions']} "
            f"Missing={recovery_log['missingQuestions']} "
            f"HandwrittenOcrExecuted={recovery_log['handwrittenOcrExecuted']} "
            f"RegionsProcessed={recovery_log['handwrittenOcrRegionsProcessed']} "
            f"Recovered={recovery_log['recoveredQuestions']} "
            f"Logical={recovery_log['logicalQuestions']} "
            f"Ownership={recovery_log['ownershipQuestions']} "
            f"Crop={recovery_log['cropCount']} "
            f"Delivered={recovery_log['deliveredCount']} | "
            f"IN_COLUMN(regions={gt['IN_COLUMN']['regionsProcessed']},rec={gt['IN_COLUMN']['recovered']}) "
            f"CROSS_COLUMN(regions={gt['CROSS_COLUMN']['regionsProcessed']},rec={gt['CROSS_COLUMN']['recovered']}) "
            f"CROSS_PAGE(regions={gt['CROSS_PAGE']['regionsProcessed']},rec={gt['CROSS_PAGE']['recovered']})",
            flush=True,
        )
    except Exception:  # noqa: BLE001 — logging must never break the request
        pass

    return analysis
