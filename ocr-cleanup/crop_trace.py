"""UNIVERSAL CROP TRACE ENGINE — validate CROP CONSTRUCTION itself, not counts.

Counts can all pass (logical == ownership == complete, cropGate PASS, deliver true) while the
crops are still wrong. This is a READ-ONLY diagnostic that traces EVERY question through the
real construction order and explains every outcome — never a generic FAIL:

    ownership → recover → crop → repair → validate → deliver

It is document-agnostic: pass ANY PDF. It does NOT add detectors/heuristics and does NOT modify
the engine — it runs the production pipeline (ocr_page → build_document) and re-derives each crop
with the SAME crop_engine + the SAME per-page coordinate scale + the SAME locked question-number
box production uses, so what it reports is what is delivered.

Per question it prints + records:
    questionId / questionNumber / page / column
    ownership   — owner count, owned elements, foreign ownership (conflicts), detached
    recover     — missing / recovered
    crop        — regions (page, column, bbox) + COORDINATE-SPACE fit against the render
    repair      — edges before → expansion → edges after (incl. number-visibility)
    validation  — boundary cuts (top/bottom/left/right) + crop-ownership (every element present)
    deliver     — DELIVER | REVIEW
    reason      — the SPECIFIC explanation

Then a document-level BUILD VALIDATION REPORT (Logical / Ownership / Complete / Crop / Delivered,
Boundary Violations, Foreign Ownership, Missing Options, Detached Options, Visual Ownership Issues,
Cross-page / Cross-column Issues, Stage 1 + Stage 2 N=N=C, PASS/FAIL).

Each crop PNG is saved to crop-trace-out/<doc>/qNN.png for visual inspection.

Usage:
    .venv/Scripts/python.exe crop_trace.py <path-to.pdf>
"""
from __future__ import annotations

import base64
import io
import os
import sys
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:  # console may be cp1252 on Windows — force UTF-8 so the report never crashes on a glyph
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:  # noqa: BLE001
    pass

from app.ocr_engine.document_engine import BUILD_DPI
from app.ocr_engine.router import ocr_page
from app.structure_engine import coordinate_validator, crop_engine
from app.structure_engine.document_builder import (
    _median_line_height,
    _ownership_extents,
    _scale_anchor,
    _scale_number_box,
    _scale_regions,
    _top_anchor,
    build_document,
)

_VISUAL = ("diagram", "graph", "table", "equation", "chemical_structure")


# ─────────────────────────────────────────────────────────────────────────────
# Stage 0 — run the REAL pipeline, but KEEP the page renders so we can trace crops
# ─────────────────────────────────────────────────────────────────────────────
def run_pipeline(pdf_path: str) -> Tuple[Dict[str, Any], Dict[int, Any], Dict[str, Any]]:
    """Mirror document_engine.process_document (same ocr_page, same BUILD_DPI render) but capture the
    PIL page images so the trace can re-derive each crop exactly as the builder does."""
    import fitz
    from PIL import Image

    doc_id = os.path.splitext(os.path.basename(pdf_path))[0]
    with open(pdf_path, "rb") as fh:
        pdf_bytes = fh.read()

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pages_payload: List[dict] = []
    page_images: Dict[int, Any] = {}
    routing: List[dict] = []
    try:
        for index in range(doc.page_count):
            page = doc.load_page(index)
            tokens, r = ocr_page(page, index)
            pix = page.get_pixmap(dpi=BUILD_DPI, alpha=False)
            png = pix.tobytes("png")
            page_images[index] = Image.open(io.BytesIO(png)).convert("RGB")
            pages_payload.append({
                "index": index,
                "width": round(r.width, 2),
                "height": round(r.height, 2),
                "words": [t.to_word() for t in tokens],
                "imageBase64": base64.b64encode(png).decode("ascii"),
            })
            routing.append(r.to_dict())
    finally:
        doc.close()

    payload = {"documentId": doc_id, "pages": pages_payload}
    analysis = build_document(payload)
    analysis["_routing"] = routing
    return analysis, page_images, payload


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────
def _col_of(x0: float, x1: float, page_w: float) -> str:
    mid = page_w / 2.0
    if x1 <= mid * 1.05:
        return "LEFT"
    if x0 >= mid * 0.95:
        return "RIGHT"
    return "FULL/SPAN"


def _heatmap_for(analysis: Dict[str, Any], qid: str) -> Dict[str, Any]:
    for h in analysis.get("ownershipHeatmap", []):
        if h.get("questionId") == qid:
            return h
    return {}


def _present_option_labels(q: Dict[str, Any]) -> List[str]:
    return sorted({str(o.get("label")).upper() for o in q.get("options", []) if o.get("label")})


def _coord_fit(regions, img_w: int, img_h: int) -> Dict[str, Any]:
    """After scaling, does the question's owned region fill a believable fraction of the render?
    A region confined to a small top-left fraction means the point/pixel scale was NOT applied."""
    if not regions:
        return {"ok": False, "fracX": 0.0, "fracY": 0.0, "imageW": img_w, "imageH": img_h}
    max_x1 = max(r[3] for r in regions)
    max_y1 = max(r[4] for r in regions)
    fx = max_x1 / img_w if img_w else 0.0
    fy = max_y1 / img_h if img_h else 0.0
    suspect = fx <= 0.45 and fy <= 0.55  # 72/200 ≈ 0.36 — the fragment signature
    return {"ok": not suspect, "fracX": round(fx, 3), "fracY": round(fy, 3),
            "imageW": img_w, "imageH": img_h, "suspect": suspect}


# ─────────────────────────────────────────────────────────────────────────────
# Per-question trace
# ─────────────────────────────────────────────────────────────────────────────
def trace_question(
    q: Dict[str, Any],
    idx: int,
    anchors_pt: List[Optional[Tuple]],
    page_images: Dict[int, Any],
    step_px: float,
    expected_options: int,
    analysis: Dict[str, Any],
    scales: Dict[int, float],
) -> Dict[str, Any]:
    qid, number = q.get("id"), q.get("number")
    boxes, options = list(q.get("boxes", [])), list(q.get("options", []))
    hm = _heatmap_for(analysis, qid)

    pages = sorted({b.get("page") for b in boxes} | {o.get("page") for o in options})
    completeness = hm.get("completeness")
    checks = hm.get("checks", {})
    missing = hm.get("missing", [])
    conflicts = hm.get("ownershipConflicts", [])   # FOREIGN OWNERSHIP: element claimed by >1 question
    detached = hm.get("detached", [])

    # crop regions in render-pixel space (per-page scale — exactly as production)
    regions = _scale_regions(crop_engine.regions_for_question(q), scales)
    anchor_top = _scale_anchor(anchors_pt[idx], scales)
    anchor_bot = _scale_anchor(anchors_pt[idx + 1], scales) if idx + 1 < len(anchors_pt) else None
    number_box = _scale_number_box(q.get("numberBox"), scales)

    first_img = page_images.get(pages[0]) if pages else None
    img_w, img_h = (first_img.width, first_img.height) if first_img else (0, 0)
    coord = _coord_fit(regions, img_w, img_h)
    region_desc = [
        {"page": r[0],
         "col": _col_of(r[1], r[3], (page_images.get(r[0]).width if page_images.get(r[0]) else img_w) or 1),
         "bbox": [round(r[1], 1), round(r[2], 1), round(r[3], 1), round(r[4], 1)]}
        for r in regions
    ]
    cols = sorted({rd["col"] for rd in region_desc})

    # repair (build → detect cuts → expand → rebuild), with the locked number box
    png_first = crop_engine.build_crop(regions, page_images)
    edges_before = {"top": False, "bottom": False, "left": False, "right": False}
    if png_first:
        from PIL import Image
        edges_before = crop_engine.detect_edge_cuts(Image.open(io.BytesIO(png_first)).convert("RGB"))
    png, final_regions, edges_after = crop_engine.repair_crop(
        regions, page_images, step=step_px, max_iters=4,
        top_anchor=anchor_top, bottom_anchor=anchor_bot, number_box=number_box,
    )

    boundary_cut = {k: bool(edges_after.get(k)) for k in ("top", "bottom", "left", "right")}
    number_cut = bool(edges_after.get("number"))
    valid_crop = png is not None and not any(edges_after.values())

    crop_owns = {
        "question_number": checks.get("question_number", "N/A"),
        "question_text": checks.get("question_text", "N/A"),
        "options": checks.get("options", "N/A"),
        "continuation": checks.get("continuation", "N/A"),
        **{k: checks.get(k, "N/A") for k in _VISUAL},
    }

    # question integrity: expected / detected / missing / detached
    expected_elems = ["question_number", "question_text"]
    if int(q.get("optionCount", 0)) > 0:
        expected_elems += [f"option_{l}" for l in ["A", "B", "C", "D", "E"][:expected_options]]
    expected_elems += [k for k in _VISUAL if crop_owns.get(k) == "PASS"]
    detected = (["question_number"] if number is not None else []) \
        + (["question_text"] if boxes else []) \
        + [f"option_{l}" for l in _present_option_labels(q)] \
        + [k for k in _VISUAL if crop_owns.get(k) == "PASS"]

    # status + SPECIFIC reasons (never generic FAIL)
    reasons: List[str] = []
    if not boxes:
        reasons.append("OWNERSHIP: owns no boxes (empty owner)")
    if conflicts:
        reasons.append(f"FOREIGN OWNERSHIP: element claimed by >1 question ({len(conflicts)})")
    if detached:
        reasons.append(f"DETACHED: element(s) not merged into the owner: {detached}")
    if missing:
        reasons.append(f"MISSING: un-owned element(s): {missing}")
    if coord.get("suspect"):
        reasons.append(
            f"COORD: region reaches only {coord['fracX']*100:.0f}%x{coord['fracY']*100:.0f}% of the "
            f"{img_w}x{img_h} render — point/pixel scale not applied (top-left fragment)")
    if png is None:
        reasons.append("CROP: no crop produced (no region or render missing)")
    for side in ("left", "right", "top", "bottom"):
        if boundary_cut[side]:
            reasons.append(f"BOUNDARY: {side} edge cut — content clipped on the {side}")
    if number_cut:
        reasons.append("NUMBER: question number not visible in the crop (cut/trimmed)")

    status = "DELIVER" if (valid_crop and not reasons) else "REVIEW"
    return {
        "questionId": qid, "number": number, "pages": pages, "columns": cols,
        "ownership": {"ownerOk": bool(boxes), "boxes": len(boxes), "options": len(options),
                      "completeness": completeness, "foreignOwnership": len(conflicts),
                      "detached": len(detached)},
        "recover": {"missing": missing},
        "crop": {"regionCount": len(regions), "regions": region_desc, "coord": coord,
                 "pngBytes": len(png) if png else 0},
        "repair": {"edgesBefore": edges_before, "edgesAfter": edges_after,
                   "grew": final_regions != [tuple(r) for r in regions]},
        "validation": {"boundaryCut": boundary_cut, "numberVisible": not number_cut,
                       "cropOwnership": crop_owns, "validCrop": valid_crop},
        "integrity": {"expected": expected_elems, "detected": detected,
                      "missing": [e for e in expected_elems if e not in detected],
                      "detached": detached},
        "deliver": status,
        "reason": reasons or ["ownership complete, coords aligned, crop in-bounds, number visible, no cuts"],
        "_png": png,
    }


def _e(d: Dict[str, bool]) -> str:
    on = [k for k, v in d.items() if v]
    return "+".join(on) if on else "clean"


# ─────────────────────────────────────────────────────────────────────────────
# Document-level BUILD VALIDATION REPORT
# ─────────────────────────────────────────────────────────────────────────────
def _chrome_count(payload) -> int:
    """Header/footer/page-number artifacts detected as repeated page chrome (excluded from ownership
    — KEEP PIXELS, never deleted). Derived from the document's own repeated-edge tokens; not tuned."""
    try:
        from app.structure_engine.models import DocumentInput
        from app.structure_engine.repeated_chrome import detect_chrome
        doc = DocumentInput.from_dict(payload)
        chrome = detect_chrome(doc.pages)
        return sum(len(v) for v in chrome.values())
    except Exception:  # noqa: BLE001
        return 0


def build_validation_report(traces, analysis, payload) -> Dict[str, Any]:
    qs = analysis.get("questions", [])
    qc = analysis.get("questionCount", {})
    seq = analysis.get("sequence", {})
    nnc = (analysis.get("integrity") or {}).get("nnc", {})
    s1 = nnc.get("stage1", {})
    s2 = (analysis.get("build") or {}).get("stage2", {})
    routing = analysis.get("_routing", [])
    boundary = sum(1 for t in traces if any(t["validation"]["boundaryCut"].values()))
    foreign = sum(t["ownership"]["foreignOwnership"] for t in traces)
    missing_opts = sum(1 for t in traces for m in t["recover"]["missing"] if str(m).startswith("option"))
    detached = sum(len(t["integrity"]["detached"]) for t in traces)
    visual_issues = sum(1 for t in traces for k in _VISUAL if t["validation"]["cropOwnership"].get(k) == "FAIL")
    # cross-page / cross-column ISSUES = spanning questions that did NOT cleanly deliver (review or a
    # boundary cut). A correctly-merged cross-page/column question is NOT an issue (it is the feature).
    review_ids = {t["questionId"] for t in traces if t["deliver"] != "DELIVER"}
    cross_page = sum(1 for q in qs if q.get("multiPage") and q.get("id") in review_ids)
    cross_col = sum(1 for q in qs if q.get("multiColumn") and q.get("id") in review_ids)
    cross_page_total = sum(1 for q in qs if q.get("multiPage"))
    cross_col_total = sum(1 for q in qs if q.get("multiColumn"))
    delivered = sum(1 for t in traces if t["deliver"] == "DELIVER")
    crop_count = (analysis.get("build") or {}).get("cropCount", 0)
    missing_nums = qc.get("missingQuestions", [])
    recovered_nums = qc.get("recoveredQuestions", [])
    duplicates = seq.get("duplicates", [])
    q0 = 1 if seq.get("questionZero") else 0
    impossible = len(seq.get("impossible", []))
    degraded = sum(1 for r in routing if r.get("degraded"))
    s1_pass = bool(s1.get("pass"))
    s2_pass = s2.get("status") == "PASS"
    overall = bool(analysis.get("deliver")) and boundary == 0 and foreign == 0 and detached == 0 \
        and missing_opts == 0 and visual_issues == 0 and not missing_nums and not duplicates \
        and q0 == 0 and impossible == 0 and s1_pass and s2_pass
    return {
        "Page Count": len(payload.get("pages", [])),
        "Logical Question Count": qc.get("logicalQuestionCount"),
        "Ownership Count": s1.get("ownershipCount"),
        "Complete Questions": s1.get("completeQuestionCount"),
        "Crop Count": crop_count,
        "Delivered Count": (analysis.get("build") or {}).get("deliveredQuestionCount"),
        "Trace DELIVER": delivered,
        "Missing Numbers": missing_nums or 0,
        "Recovered Numbers": recovered_nums or 0,
        "Duplicate Questions": duplicates or 0,
        "Question 0 Occurrences": q0,
        "Impossible Sequences": impossible,
        "Cross-page Issues": f"{cross_page} (of {cross_page_total} spanning, merged OK)",
        "Cross-column Issues": f"{cross_col} (of {cross_col_total} spanning, merged OK)",
        "Header Removed (pages)": (analysis.get("chromeCleanup") or {}).get("headerRemovals", 0),
        "Footer Removed (pages)": (analysis.get("chromeCleanup") or {}).get("footerRemovals", 0),
        "Header band (frac)": (analysis.get("chromeCleanup") or {}).get("headerFrac", 0.0),
        "Footer band (frac)": (analysis.get("chromeCleanup") or {}).get("footerFrac", 0.0),
        "Divider/Rule lines removed": (analysis.get("chromeCleanup") or {}).get("dividerCols", 0)
        + (analysis.get("chromeCleanup") or {}).get("ruleRows", 0),
        "Header/Footer text artifacts (markers)": _chrome_count(payload),
        "Background/Watermark Removals": "upstream (Python /cleanup, not measured in build)",
        "Degraded Pages (KEEP PIXELS)": degraded,
        "Detached Options": detached,
        "Boundary Violations": boundary,
        "Foreign Ownership": foreign,
        "Visual Ownership Issues": visual_issues,
        "Stage 1 N=N=C": "PASS" if s1_pass else "STOP",
        "Stage 2 N=N=C": "PASS" if s2_pass else (s2.get("status") or "STOP"),
        "VERDICT": "PASS" if overall else "FAIL",
    }


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────
def main(argv: List[str]) -> int:
    if len(argv) < 2:
        print("usage: crop_trace.py <path-to.pdf>   (document-agnostic — pass any PDF)")
        return 2
    pdf_path = argv[1]
    if not os.path.exists(pdf_path):
        print(f"PDF not found: {pdf_path}")
        return 1

    doc_id = os.path.splitext(os.path.basename(pdf_path))[0]
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "crop-trace-out", doc_id)
    os.makedirs(out_dir, exist_ok=True)

    print(f"Running production pipeline (render @ {BUILD_DPI}dpi) on: {os.path.basename(pdf_path)}")
    analysis, page_images, payload = run_pipeline(pdf_path)

    questions = analysis.get("questions", [])
    qc = analysis.get("questionCount", {})
    nnc = (analysis.get("integrity") or {}).get("nnc", {})
    expected_options = int(qc.get("expectedOptionCount", 4) or 4)

    # COORDINATE-SPACE VALIDATION (same gate as production) — per-page scale + alignment.
    render_dims = {i: (img.width, img.height) for i, img in page_images.items()}
    coord = analysis.get("coordinate") or coordinate_validator.validate(
        payload.get("pages", []), render_dims, _ownership_extents(questions))
    scales = coord.get("scaleByPage") or {}
    doc_scale = coord.get("documentScale") or 1.0
    anchors_pt = [_top_anchor(q) for q in questions]
    step_px = max(2.0 * _median_line_height(payload), 16.0) * doc_scale

    deg = sum(1 for r in analysis.get("_routing", []) if r.get("degraded"))
    print("=" * 80)
    print(f"DOCUMENT: {doc_id}")
    print(f"  pages={len(payload['pages'])}  logical={qc.get('logicalQuestionCount')}  "
          f"complete={qc.get('completeQuestionCount')}  expectedOptions={expected_options}")
    print(f"  cropGate={analysis.get('cropGate')}  stage1={(nnc.get('stage1') or {}).get('pass')}  "
          f"deliver={analysis.get('deliver')}  degradedPages={deg}")
    print(f"  COORD ALIGNED={coord.get('aligned')}  docScale={doc_scale}  "
          f"reasons={coord.get('reasons') or 'none'}")
    print("=" * 80)

    traces = []
    for i, q in enumerate(questions):
        t = trace_question(q, i, anchors_pt, page_images, step_px, expected_options, analysis, scales)
        traces.append(t)
        if t["_png"]:
            with open(os.path.join(out_dir, f"q{(t['number'] or 0):03d}.png"), "wb") as fh:
                fh.write(t["_png"])
        c = t["crop"]["coord"]
        print(f"\nQ{t['number']}  id={t['questionId']}  pages={t['pages']}  cols={t['columns']}")
        print(f"  OWNERSHIP : ownerOk={t['ownership']['ownerOk']} boxes={t['ownership']['boxes']} "
              f"options={t['ownership']['options']} completeness={t['ownership']['completeness']} "
              f"foreignOwnership={t['ownership']['foreignOwnership']} detached={t['ownership']['detached']}")
        print(f"  RECOVER   : missing={t['recover']['missing'] or 'none'}")
        print(f"  CROP      : regions={t['crop']['regionCount']} pngBytes={t['crop']['pngBytes']} "
              f"coordFit={c.get('fracX')}x{c.get('fracY')} of {c.get('imageW')}x{c.get('imageH')} "
              f"suspect={c.get('suspect')}")
        print(f"  REPAIR    : before={_e(t['repair']['edgesBefore'])} grew={t['repair']['grew']} "
              f"after={_e(t['repair']['edgesAfter'])}")
        print(f"  VALIDATE  : boundaryCut={_e(t['validation']['boundaryCut'])} "
              f"numberVisible={t['validation']['numberVisible']} validCrop={t['validation']['validCrop']}")
        print(f"              cropOwnership={t['validation']['cropOwnership']}")
        print(f"  INTEGRITY : missing={t['integrity']['missing'] or 'none'} "
              f"detached={t['integrity']['detached'] or 'none'}")
        print(f"  DELIVER   : {t['deliver']}")
        for r in t["reason"]:
            print(f"      - {r}")

    print("\n" + "=" * 80)
    print(f"BUILD VALIDATION REPORT  —  {doc_id}")
    print("-" * 80)
    report = build_validation_report(traces, analysis, payload)
    for k, v in report.items():
        print(f"  {k:<26}: {v}")
    print("=" * 80)
    print(f"  crops saved to: {out_dir}")
    return 0 if report["VERDICT"] == "PASS" else 3


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
