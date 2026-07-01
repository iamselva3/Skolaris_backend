"""Render CLEAN-CONTENT crops: cropped straight from the RAW page render, with NO background-removal /
watermark-lift / seal chain — so the crop shows EXACTLY the PDF content (no colour change, no damage).
Flags likely defects per crop: right/bottom edge ink (a clip), and an over-tall crop (solution included).

  python render_clean_crops.py <capture.tokens.json> <outDir>
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:  # noqa: BLE001
    pass

from PIL import Image  # noqa: E402

from app.structure_engine.pipeline import analyze_document  # noqa: E402


def _patch_dims(cap):
    for p in cap["pages"]:
        if p.get("imageBase64") and not p.get("width"):
            im = Image.open(io.BytesIO(base64.b64decode(p["imageBase64"])))
            p["width"], p["height"] = im.width, im.height


def _edge_ink(im, dark=130):
    g = im.convert("L")
    w, h = g.size
    px = g.load()
    band = max(1, min(5, w // 60))
    rcol = sum(1 for y in range(h) for x in range(w - band, w) if px[x, y] < dark) / max(1, h * band)
    brow = sum(1 for x in range(w) for y in range(h - band, h) if px[x, y] < dark) / max(1, w * band)
    return round(rcol, 3), round(brow, 3)


def main(argv):
    cap_path, out_dir = argv[1], argv[2]
    os.makedirs(out_dir, exist_ok=True)
    cap = json.load(open(cap_path, encoding="utf-8"))
    _patch_dims(cap)
    res = analyze_document(cap)
    qs = res.get("questions", [])
    renders = {p["index"]: Image.open(io.BytesIO(base64.b64decode(p["imageBase64"]))).convert("RGB")
               for p in cap["pages"] if p.get("imageBase64")}

    heights = []
    rows = []
    for q in qs:
        regions = q.get("cropRegions") or []
        ordered = sorted(regions, key=lambda r: (r["page"], r["x0"], r["y0"]))
        parts = []
        for r in ordered:
            im = renders.get(r["page"])
            if im is None:
                continue
            x0, y0, x1, y1 = int(r["x0"]), int(r["y0"]), int(r["x1"]), int(r["y1"])
            if x1 - x0 < 4 or y1 - y0 < 4:
                continue
            parts.append(im.crop((x0, y0, x1, y1)))
        if not parts:
            continue
        w = max(p.width for p in parts)
        h = sum(p.height for p in parts)
        canvas = Image.new("RGB", (w, h), (255, 255, 255))
        y = 0
        for p in parts:
            canvas.paste(p, (0, y)); y += p.height
        num = q.get("number")
        name = f"q{num:03d}.png" if isinstance(num, int) and num >= 1 else f"qx{len(rows):03d}.png"
        canvas.save(os.path.join(out_dir, name))  # NO clean chain — raw content
        rcol, brow = _edge_ink(canvas)
        heights.append(h)
        rows.append({"n": num, "name": name, "w": w, "h": h, "rEdge": rcol, "bEdge": brow,
                     "opts": q.get("optionCount"), "regions": len(regions),
                     "type": q.get("questionType") or q.get("question_type")})

    med_h = sorted(heights)[len(heights) // 2] if heights else 0
    clips = [r for r in rows if r["rEdge"] > 0.04]
    tall = [r for r in rows if med_h and r["h"] > med_h * 2.2]
    print(f"questions={len(qs)} saved={len(rows)} medianH={med_h}")
    clip_str = [(r["n"], r["rEdge"], str(r["w"]) + "x" + str(r["h"])) for r in clips[:20]]
    tall_str = [(r["n"], r["h"]) for r in tall[:20]]
    print(f"RIGHT-EDGE CLIP (rEdge>0.04): {len(clips)} -> {clip_str}")
    print(f"OVER-TALL (h>2.2*med, maybe solution/diagram): {len(tall)} -> {tall_str}")
    json.dump({"medianH": med_h, "rows": rows}, open(os.path.join(out_dir, "_audit.json"), "w"), indent=2)


if __name__ == "__main__":
    main(sys.argv)
