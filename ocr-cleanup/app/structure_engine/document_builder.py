"""End-to-end document build — Python is the SINGLE engine that returns finished crops.

Pipeline (Visual Intelligence runs BEFORE crop construction, per the architecture):
    tokens (+ page renders) → ownership graph → ownership completeness
    → Python Visual Intelligence (CV on renders: diagram/graph/table/equation/chem)
    → visual attachment → crop construction → crop repair → crop validation
    → Stage 1 N=N=C → Stage 2 N=N=C → return crop bytes (TS only stores)

Input payload (per page): { index, width, height, words[], imageBase64? }. The render is
the SAME coordinate space as the OCR word boxes (OCR ran on that render), so the ownership
bboxes crop directly from it. Output: the analysis + per-question crop PNGs (base64) + the
two-stage N=N=C + a single `deliver` flag. `deliver` is True only when every gate passes;
otherwise the document routes to REVIEW (repair-first, review-last). Never raises.
"""
from __future__ import annotations

import base64
import io
from statistics import median
from typing import Any, Dict, List

from . import coordinate_validator, crop_engine, crop_visibility, leading_marker, page_chrome_cv
from .pipeline import analyze_document
from .visual_detectors import VISUAL_CV_AVAILABLE, classify_region_cv

_VISUAL_KINDS = ("diagram", "graph", "table", "equation", "chemical_structure")


def _decode_images(payload: Dict[str, Any]) -> Dict[int, Any]:
    imgs: Dict[int, Any] = {}
    if not crop_engine.CROP_AVAILABLE:
        return imgs
    from PIL import Image  # available when CROP_AVAILABLE
    for p in payload.get("pages", []):
        b = p.get("imageBase64") or p.get("image_base64")
        if not b:
            continue
        try:
            imgs[int(p.get("index"))] = Image.open(io.BytesIO(base64.b64decode(b))).convert("RGB")
        except Exception:  # noqa: BLE001
            continue
    return imgs


def _median_line_height(payload: Dict[str, Any]) -> float:
    hs = [
        float(w.get("y1", 0)) - float(w.get("y0", 0))
        for p in payload.get("pages", [])
        for w in (p.get("words") or [])
        if float(w.get("y1", 0)) > float(w.get("y0", 0))
    ]
    return float(median(hs)) if hs else 20.0


def _page_scale(images: Dict[int, Any], payload: Dict[str, Any]) -> float:
    """Render PIXELS per OCR POINT. The OCR boxes are in PDF points; the page renders are higher-DPI
    (e.g. 200 DPI ⇒ 2.78×). The crop engine works in render-pixel space, so point-space regions MUST be
    scaled by this factor before cropping — otherwise a point coordinate read as a pixel lands ~1/scale
    of the way up the page and the crop samples the wrong region (the previous question's lines)."""
    for p in payload.get("pages", []):
        img = images.get(int(p.get("index")))
        w = float(p.get("width") or 0)
        if img is not None and w > 0:
            return img.width / w
    return 1.0


def _scale_of(scales, pg) -> float:
    """The point→pixel scale for one page. `scales` is either a single global float (uniform-DPI
    doc) or a {page_index: scale} map (per-page, so a page rendered differently is honoured). This
    is the ONLY bridge between OCR-point space and render-pixel space — derived, never hardcoded."""
    return float(scales.get(int(pg), 1.0)) if isinstance(scales, dict) else float(scales)


def _scale_regions(regions, scales):
    return [(pg, x0 * _scale_of(scales, pg), y0 * _scale_of(scales, pg),
             x1 * _scale_of(scales, pg), y1 * _scale_of(scales, pg)) for (pg, x0, y0, x1, y1) in regions]


def _scale_anchor(a, scales):
    if not a:
        return None
    s = _scale_of(scales, a[0])
    return (a[0], a[1] * s, a[2] * s, a[3] * s)


def _scale_number_box(nb, scales):
    """Scale a [page, x0, y0, x1, y1] number box from OCR-point space to render-pixel space (the
    space the crop engine works in). None ⇒ no locked number (numberless/recovered question)."""
    if not nb or len(nb) < 5:
        return None
    s = _scale_of(scales, nb[0])
    return (int(nb[0]), float(nb[1]) * s, float(nb[2]) * s, float(nb[3]) * s, float(nb[4]) * s)


def _ownership_extents(questions: List[Dict[str, Any]]) -> Dict[int, "tuple[float, float]"]:
    """Per page, the deepest owned point (max x1, max y1) across all question boxes + options, in
    OCR-point space. Feeds the coordinate validator's fit check: scaled, these must land inside the
    render — proving the ownership/crop coords share the render's space (not a different scale)."""
    ext: Dict[int, "tuple[float, float]"] = {}
    for q in questions:
        for e in list(q.get("boxes", [])) + list(q.get("options", [])):
            pg = int(e["page"])
            cx, cy = ext.get(pg, (0.0, 0.0))
            ext[pg] = (max(cx, float(e["x1"])), max(cy, float(e["y1"])))
    return ext


def _top_anchor(question: Dict[str, Any]):
    """A question's crop-boundary anchor: (page, y0, x0, x1) of its TOPMOST owned box (the question
    number/stem start), in reading order. None if it owns nothing. Used to bound this question's crop
    above and the previous question's crop below — one question = one owner = one crop."""
    boxes = list(question.get("boxes", [])) + list(question.get("options", []))
    if not boxes:
        return None
    b = min(boxes, key=lambda e: (int(e["page"]), float(e["y0"])))
    return (int(b["page"]), float(b["y0"]), float(b["x0"]), float(b["x1"]))


def _visual_intelligence(question: Dict[str, Any], images: Dict[int, Any], scale: float = 1.0) -> None:
    """Run the CV layer on the question's owned regions and PROMOTE visuals from N/A to PASS
    (diagram/graph/table/equation/chemical). Token PASS is kept; CV adds graph/chem. Regions are scaled
    to render-pixel space (same as crop construction) so the CV samples the correct area."""
    if not VISUAL_CV_AVAILABLE:
        return
    flags: Dict[str, bool] = {k: False for k in _VISUAL_KINDS}
    for (pg, x0, y0, x1, y1) in _scale_regions(crop_engine.regions_for_question(question), scale):
        img = images.get(int(pg))
        if img is None:
            continue
        sub = img.crop((max(0, int(x0)), max(0, int(y0)),
                        min(img.width, int(x1)), min(img.height, int(y1))))
        cv = classify_region_cv(sub)
        for k, v in cv.items():
            flags[k] = flags[k] or bool(v)
    visuals = question.setdefault("visuals", {})
    for k in _VISUAL_KINDS:
        if flags[k] and visuals.get(k) in (None, "N/A"):
            visuals[k] = "PASS"


def build_document(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Run the full build. Returns the analysis dict plus `crops`, `build` (Stage 2), `deliver`.

    Badge/seal question-number recovery (count + ownership fix) is done INSIDE analyze_document — the
    pipeline reads each page render (imageBase64, which this payload carries) and injects the badge
    markers — so it is NOT repeated here (doing so would double-count)."""
    try:
        analysis = analyze_document(payload)
    except Exception as e:  # noqa: BLE001
        return {"deliver": False, "crops": [], "build": {"stage2": {"status": "STOP"}},
                "error": f"analyze:{type(e).__name__}", "cropGate": "REVIEW"}

    images = _decode_images(payload)
    result: Dict[str, Any] = dict(analysis)
    # CLEANUP STAGE (runs for EVERY document, before any crop is cut): whiten repeated header/footer
    # bands + divider/rule lines so Python crops never carry the page chrome the old TS display path
    # used to strip. Pixel-based + cross-page (catches a LOGO as well as text), document-derived (no
    # PDF/institute specifics), KEEP-PIXELS (only high-confidence repeated chrome; a clean doc or <3
    # pages ⇒ unchanged). Crops, Visual Intelligence and coordinate checks all read the cleaned renders.
    if images:
        images, result["chromeCleanup"] = page_chrome_cv.detect_and_clean(images)
    result["crops"] = []
    result["build"] = {"cropCount": 0, "deliveredQuestionCount": 0,
                       "stage2": {"cropCount": None, "deliveredQuestionCount": None, "status": "PENDING_WIRING"}}
    result["deliver"] = False

    questions = analysis.get("questions", [])
    stage1_pass = analysis.get("integrity", {}).get("nnc", {}).get("stage1", {}).get("pass", False)

    # No renders, or the pre-crop gate already failed ⇒ cannot build/deliver (route to review).
    if not images or analysis.get("cropGate") != "PASS" or not stage1_pass:
        return result

    # COORDINATE-SPACE VALIDATION (independent of every count gate). The OCR/ownership boxes are in
    # PDF points; the renders are in pixels. Prove those spaces ALIGN on every content page — same
    # aspect, one DPI across the doc, scaled ownership lands inside the render — BEFORE cutting any
    # crop. A mix (the top-left-fragment failure) passes all counts but is wrong; it is an input-
    # contract defect repair cannot fix → KEEP PIXELS, route the whole document to review. The scale
    # is derived PER PAGE from the render itself (render_dim / page_dim), never hardcoded.
    render_dims = {i: (img.width, img.height) for i, img in images.items()}
    coord = coordinate_validator.validate(payload.get("pages", []), render_dims, _ownership_extents(questions))
    result["coordinate"] = coord
    if not coord["aligned"]:
        result["notes"] = (result.get("notes") or []) + [
            "coordinate spaces misaligned (" + "; ".join(coord["reasons"][:6])
            + ") — KEEP PIXELS, routed to review"]
        return result
    scales = coord["scaleByPage"]                  # per-page point→pixel scale (validated to align)
    doc_scale = coord["documentScale"] or 1.0      # the document's single DPI scale (for step sizing)

    # 1) Python Visual Intelligence on renders (BEFORE crop construction) — promote graph/chem.
    for q in questions:
        _visual_intelligence(q, images, scales)

    # 2) crop construction + repair + validation per question.
    # Crop boundaries are ANCHORED by question starts: a question's crop spans from its OWN first owned
    # box down to the NEXT question's first owned box — so it never inherits the previous question's
    # trailing equation/answer (the Q24 bug) and never bleeds into the next question. Anchors are taken
    # in reading order; the clamp inside repair_crop is column-aware (two-column layouts stay separate).
    anchors = [_scale_anchor(_top_anchor(q), scales) for q in questions]
    expected_options = int((analysis.get("questionCount") or {}).get("expectedOptionCount") or 4)
    step = max(2.0 * _median_line_height(payload), 16.0) * doc_scale
    crops: List[Dict[str, Any]] = []
    for i, q in enumerate(questions):
        regions = _scale_regions(crop_engine.regions_for_question(q), scales)
        # The question-number box (scaled to render-pixel space) is an INTERNAL ANCHOR only: repair_crop
        # uses it to keep the number's ROW in the crop (so the same-line stem is not clipped) and then
        # ERASES the number from the delivered image — the crop is content-only; the UI owns numbering.
        number_box = _scale_number_box(q.get("numberBox"), scales)
        png, _regs, edges = crop_engine.repair_crop(
            regions, images, step=step, max_iters=4,
            top_anchor=anchors[i],
            bottom_anchor=anchors[i + 1] if i + 1 < len(anchors) else None,
            number_box=number_box,
            remove_number=True,
        )
        # SAFETY PASS — erase a leading question-number BADGE the token-based number_box removal cannot
        # see: a circled/boxed number, an "NM"-style tag, a handwritten/decorative mark. Pixel-level +
        # OCR-independent, content-safe (only an isolated leading blob with a real indent gap is erased;
        # a stem starting with a word is untouched). Catches the "143 NM still visible" case.
        badge_erased = False
        if png is not None:
            png, badge_erased = leading_marker.erase_png(png)
        number_removed = not bool(edges.get("number"))
        # A crop is valid only when no edge defect remains AND the number was removed (content only).
        # If numbering still appears (edges['number']) → removal failed → review. Never silently deliver.
        valid = png is not None and not any(edges.values())
        crops.append({
            "questionId": q.get("id"),
            "number": q.get("number"),
            "pngBase64": base64.b64encode(png).decode("ascii") if png else None,
            "valid": valid,
            "edges": edges,
            "visibility": {
                "numberRemoved": number_removed,
                "badgeErased": badge_erased,
                "questionTextVisible": png is not None and bool(q.get("boxes")),
                "optionsVisible": int(q.get("optionCount", 0)) == 0
                or int(q.get("optionCount", 0)) >= expected_options,
                "numberAnchorInternalOnly": True,
            },
        })

    crop_count = sum(1 for c in crops if c["valid"])
    logical = len(questions)
    stage2_pass = crop_count == logical and logical > 0

    result["crops"] = crops
    result["build"] = {
        "cropCount": crop_count,
        "deliveredQuestionCount": crop_count,
        "stage2": {
            "cropCount": crop_count,
            "deliveredQuestionCount": crop_count,
            "pass": stage2_pass,
            "status": "PASS" if stage2_pass else "STOP",
        },
    }
    # Stage 2 N=N=C FINISHED: backfill the authoritative integrity object (the analyze phase set it to
    # PENDING_WIRING before crops existed) with the REAL result now that crops are built — Stage 2 passes
    # only when cropCount == deliveredCount == logical (50==50, never 50==48).
    nnc = (result.get("integrity") or {}).get("nnc")
    if isinstance(nnc, dict):
        nnc["stage2"] = {
            "cropCount": crop_count,
            "deliveredQuestionCount": crop_count,
            "status": "PASS" if stage2_pass else "STOP",
        }
        nnc["status"] = "PASS" if (bool((nnc.get("stage1") or {}).get("pass")) and stage2_pass) else "STOP"

    # deliver only when EVERY gate passes (Stage 1 + cropGate + Stage 2). Else → review.
    result["deliver"] = bool(stage1_pass and analysis.get("cropGate") == "PASS" and stage2_pass)
    return result
