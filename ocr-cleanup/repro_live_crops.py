"""Faithful OFFLINE reproduction of the LIVE crop pipeline, straight from a captured token file.

This reproduces EXACTLY what the production pipeline delivers, with no live upload needed:

  capture (TS-OCR words + page renders, ONE pixel space)
    -> analyze_document(capture)                 # identical to the live sidecar /analyze-document
    -> for each question: crop every cropRegion from the page render, sorted (page,x0,y0), stitch
    -> /clean-crop chain  (leading_marker.erase_png -> seal_shapes.erase_top_left_seal_png)
    -> q###.png

The crop GEOMETRY comes from Python (crop_planner) and the page PIXELS come from the capture's
imageBase64 — the same two inputs the live path uses — so a footer/header/option defect seen here is
the SAME defect the reviewer sees in the app. Use it to diagnose AND to measure a fix.

Usage:
  PYTHONIOENCODING=utf-8 .venv/Scripts/python.exe repro_live_crops.py \
      [--capture newest|<path>] [--out DIR] [--report report.json] [--pages N]

  --capture newest  -> the most-recently-modified capture under crop-trace-out/capture (default)
"""
from __future__ import annotations

import base64
import glob
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:  # noqa: BLE001
    pass

from PIL import Image  # type: ignore

from app.structure_engine import leading_marker, seal_shapes
from app.structure_engine.pipeline import analyze_document

CAP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "crop-trace-out", "capture")


def _newest_capture() -> str:
    caps = sorted(glob.glob(os.path.join(CAP_DIR, "*.tokens.json")), key=os.path.getmtime)
    if not caps:
        raise SystemExit(f"no capture files in {CAP_DIR}")
    return caps[-1]


def _clean_crop(img: "Image.Image") -> "Image.Image":
    """The live /clean-crop chain, byte-for-byte: leading-marker erase -> seal erase.
    (Watermark lifting was removed from the OCR workflow — heavy watermarks are cleaned by the uploader
    before upload; page chrome is still removed document-wide by the structure engine, not per crop.)"""
    buf = io.BytesIO()
    img.save(buf, "PNG")
    b = buf.getvalue()
    try:
        b, _ = leading_marker.erase_png(b)
        b, _ = seal_shapes.erase_top_left_seal_png(b)
    except Exception:  # noqa: BLE001
        pass
    return Image.open(io.BytesIO(b)).convert("RGB")


def _stitch_vertical(parts):
    """Mirror of the TS stitchVertical: pad to the widest part, stack top-to-bottom on white."""
    if not parts:
        return None
    if len(parts) == 1:
        return parts[0]
    w = max(p.width for p in parts)
    h = sum(p.height for p in parts)
    canvas = Image.new("RGB", (w, h), (255, 255, 255))
    y = 0
    for p in parts:
        canvas.paste(p, (0, y))
        y += p.height
    return canvas


def main(argv):
    cap_arg = "newest"
    out_dir = "C:/Users/hp/Downloads/new2"
    report_path = None
    max_pages = None
    for i, a in enumerate(argv):
        if a == "--capture" and i + 1 < len(argv):
            cap_arg = argv[i + 1]
        if a == "--out" and i + 1 < len(argv):
            out_dir = argv[i + 1]
        if a == "--report" and i + 1 < len(argv):
            report_path = argv[i + 1]
        if a == "--pages" and i + 1 < len(argv):
            max_pages = int(argv[i + 1])

    cap_path = _newest_capture() if cap_arg == "newest" else cap_arg
    print(f"capture : {os.path.basename(cap_path)}")
    cap = json.load(open(cap_path, encoding="utf-8"))
    if max_pages:
        cap["pages"] = cap["pages"][:max_pages]
    os.makedirs(out_dir, exist_ok=True)

    # 1) analyze (identical to live sidecar)
    res = analyze_document(cap)
    qs = res.get("questions", [])
    qc = res.get("questionCount", {})
    print(f"pages={len(cap['pages'])}  logicalQuestions={len(qs)}  "
          f"expected={qc.get('expectedCount')}  missing={qc.get('missingQuestions')}")
    print(f"cropGate={res.get('cropGate')}  recommendation={res.get('recommendation')}")

    # 2) decode page renders (the EXACT pixels TS crops from)
    renders = {}
    for p in cap["pages"]:
        if p.get("imageBase64"):
            renders[p["index"]] = Image.open(io.BytesIO(base64.b64decode(p["imageBase64"]))).convert("RGB")

    from PIL import ImageDraw

    def _hide_number(part, r, nb):
        """Whiten the EXACT question-number box (Python knows it precisely via numberBox) in this region's
        crop. Reliable + content-safe: only the number glyph is cleared (the stem starts after a gap to its
        right), so the start of the question stays. Far more robust than the heuristic blob eraser."""
        if not nb or int(nb[0]) != r["page"]:
            return part
        nx0, ny0, nx1, ny1 = float(nb[1]), float(nb[2]), float(nb[3]), float(nb[4])
        pad = (ny1 - ny0) * 0.35 + 2.0
        lx0, ly0 = nx0 - r["x0"] - pad, ny0 - r["y0"] - pad
        lx1, ly1 = nx1 - r["x0"] + pad, ny1 - r["y0"] + pad
        if lx1 <= 0 or ly1 <= 0 or lx0 >= part.width or ly0 >= part.height:
            return part
        ImageDraw.Draw(part).rectangle(
            (max(0, int(lx0)), max(0, int(ly0)), min(part.width, int(lx1)), min(part.height, int(ly1))),
            fill=(255, 255, 255),
        )
        return part

    # 3) per question: crop each region, stitch, clean, save
    saved = 0
    rows = []
    for idx, q in enumerate(qs):
        regions = q.get("cropRegions") or q.get("crop_regions") or []
        ordered = sorted(regions, key=lambda r: (r["page"], r["x0"], r["y0"]))
        nbox = q.get("numberBox")
        parts = []
        for r in ordered:
            img = renders.get(r["page"])
            if img is None:
                continue
            x0, y0, x1, y1 = int(r["x0"]), int(r["y0"]), int(r["x1"]), int(r["y1"])
            if x1 - x0 < 4 or y1 - y0 < 4:
                continue
            part = img.crop((x0, y0, x1, y1))
            part = _hide_number(part, r, nbox)  # whiten the exact question number
            parts.append(part)
        if not parts:
            rows.append({"q": q.get("number"), "regions": len(regions), "saved": False,
                         "cropValid": q.get("cropValid"), "reason": "no_parts"})
            continue
        merged = _stitch_vertical(parts)
        merged = _clean_crop(merged)
        num = q.get("number")
        name = f"q{num:03d}.png" if isinstance(num, int) and num >= 1 else f"qx{idx:03d}.png"
        merged.save(os.path.join(out_dir, name))
        saved += 1
        rows.append({
            "q": num, "name": name, "regions": len(regions), "saved": True,
            "w": merged.width, "h": merged.height,
            "pages": sorted({r["page"] for r in ordered}),
            "optionCount": q.get("optionCount"),
            "cropValid": q.get("cropValid"),
            "needsReview": q.get("needsReview"),
            "type": q.get("questionType") or q.get("question_type"),
        })
    print(f"saved {saved}/{len(qs)} crops -> {out_dir}")

    if report_path:
        json.dump({"capture": os.path.basename(cap_path), "questionCount": qc,
                   "cropGate": res.get("cropGate"), "rows": rows},
                  open(report_path, "w", encoding="utf-8"), indent=2)
        print(f"report -> {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
