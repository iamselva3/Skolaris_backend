"""DECISIVE VALIDATION of the user's proposed architecture: Python reads the PDF DIRECTLY.

Instead of consuming the lossy TS-OCR token capture, this:
  1) opens the real PDF with PyMuPDF
  2) per page: if the page has a real embedded TEXT layer -> use it (digital, zero OCR loss);
     else render at high DPI and OCR with RapidOCR (scanned)
  3) builds the SAME capture shape {pages:[{index,width,height,words,imageBase64}]}
  4) runs the SAME analyze_document + crop render the live sidecar uses
  5) reports logicalQuestions / missing / crops — directly comparable to the TS-capture run.

This isolates ONE question: does Python-owned extraction recover the question numbers the
150-DPI TS capture lost? If the count jumps toward 180 with clean crops, the architecture works.

Usage:
  PYTHONIOENCODING=utf-8 .venv/Scripts/python.exe pdf_direct_extract.py <pdf> <outDir> [dpi] [maxPages]
"""
from __future__ import annotations

import base64
import io
import os
import sys
import time

import fitz  # PyMuPDF
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:  # noqa: BLE001
    pass

from PIL import Image  # noqa: E402

_RAPID = None


def _rapid():
    global _RAPID
    if _RAPID is None:
        from rapidocr_onnxruntime import RapidOCR
        _RAPID = RapidOCR()
    return _RAPID


def _digital_words(page) -> list[dict]:
    """Word boxes from the embedded text layer (x0,y0,x1,y1 already in render space if we scale)."""
    out = []
    for w in page.get_text("words"):
        x0, y0, x1, y1, txt = w[0], w[1], w[2], w[3], w[4]
        if txt.strip():
            out.append({"text": txt, "x0": x0, "y0": y0, "x1": x1, "y1": y1})
    return out


def _ocr_words(img: np.ndarray) -> list[dict]:
    """RapidOCR gives LINE boxes; split each line into pseudo-words with proportional x so the
    structure engine's marker / option / ownership detectors see word-level tokens."""
    res, _ = _rapid()(img)
    out: list[dict] = []
    for box, txt, _score in (res or []):
        txt = (txt or "").strip()
        if not txt:
            continue
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        lx0, lx1 = min(xs), max(xs)
        ly0, ly1 = min(ys), max(ys)
        parts = txt.split()
        if not parts:
            continue
        total = sum(len(p) for p in parts) + (len(parts) - 1)
        span = max(1.0, lx1 - lx0)
        cur = lx0
        for p in parts:
            frac = (len(p) + 1) / max(1, total)
            wx1 = cur + span * (len(p) / max(1, total))
            out.append({"text": p, "x0": float(cur), "y0": float(ly0),
                        "x1": float(wx1), "y1": float(ly1)})
            cur += span * frac
    return out


def build_capture(pdf_path: str, dpi: int, max_pages: int | None) -> dict:
    doc = fitz.open(pdf_path)
    n = doc.page_count if not max_pages else min(max_pages, doc.page_count)
    scale = dpi / 72.0
    pages = []
    for pi in range(n):
        pg = doc[pi]
        # render the page image (used for crops AND for OCR)
        pm = pg.get_pixmap(matrix=fitz.Matrix(scale, scale))
        img = np.frombuffer(pm.samples, dtype=np.uint8).reshape(pm.height, pm.width, pm.n)
        if pm.n == 4:
            img = img[:, :, :3]
        pil = Image.frombytes("RGB", (pm.width, pm.height), img.tobytes())
        buf = io.BytesIO()
        pil.save(buf, "PNG")
        b64 = base64.b64encode(buf.getvalue()).decode()

        # ROUTER: real text layer? (a scanned page has near-zero meaningful text)
        digital = _digital_words(pg)
        meaningful = [w for w in digital if any(c.isalnum() for c in w["text"]) and w["text"].strip() != "CC-315"]
        t = time.time()
        if len(meaningful) >= 40:  # genuine digital page
            words = [{"text": w["text"], "x0": w["x0"] * scale, "y0": w["y0"] * scale,
                      "x1": w["x1"] * scale, "y1": w["y1"] * scale} for w in digital]
            src = "digital"
        else:
            words = _ocr_words(img)
            src = "ocr"
        dt = time.time() - t
        pages.append({"index": pi + 1, "width": pm.width, "height": pm.height,
                      "words": words, "imageBase64": b64})
        sys.stderr.write(f"page {pi+1} {pm.width}x{pm.height} {src} words={len(words)} {dt:.1f}s\n")
    return {"documentId": os.path.basename(pdf_path), "pages": pages}


def main(argv):
    pdf = argv[1]
    out_dir = argv[2] if len(argv) > 2 else "C:/Users/hp/Downloads/reneet_pydirect"
    dpi = int(argv[3]) if len(argv) > 3 else 300
    max_pages = int(argv[4]) if len(argv) > 4 else None
    os.makedirs(out_dir, exist_ok=True)

    from app.structure_engine.pipeline import analyze_document

    # CACHE the capture (renders + OCR words) keyed by pdf+dpi+pages, so iterating on crop rendering /
    # analyze does not re-pay the OCR cost. Set PDF_EXTRACT_CACHE to a json path; reused if present.
    cache_path = os.environ.get("PDF_EXTRACT_CACHE")
    t0 = time.time()
    import json as _json
    if cache_path and os.path.exists(cache_path):
        cap = _json.load(open(cache_path, encoding="utf-8"))
        sys.stderr.write(f"capture LOADED from cache {cache_path} in {time.time()-t0:.1f}s\n")
    else:
        cap = build_capture(pdf, dpi, max_pages)
        sys.stderr.write(f"capture built in {time.time()-t0:.1f}s\n")
        if cache_path:
            _json.dump(cap, open(cache_path, "w", encoding="utf-8"))
            sys.stderr.write(f"capture cached -> {cache_path}\n")

    res = analyze_document(cap)
    qs = res.get("questions", [])
    qc = res.get("questionCount", {})
    print(f"\nPYTHON-DIRECT  pages={len(cap['pages'])}  logicalQuestions={len(qs)}  "
          f"expected={qc.get('expectedCount')}  missing={qc.get('missingQuestions')}")
    print(f"cropGate={res.get('cropGate')}  recommendation={res.get('recommendation')}")

    # render crops (same chain as repro_live_crops)
    from app.structure_engine import leading_marker, seal_shapes
    renders = {p["index"]: Image.open(io.BytesIO(base64.b64decode(p["imageBase64"]))).convert("RGB")
               for p in cap["pages"]}
    saved = 0
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
        b = io.BytesIO(); canvas.save(b, "PNG"); bb = b.getvalue()
        try:
            bb, _ = leading_marker.erase_png(bb)
            bb, _ = seal_shapes.erase_top_left_seal_png(bb)
            # Watermark lifting removed from the OCR workflow (uploader cleans heavy watermarks before
            # upload; page chrome is removed document-wide by the structure engine, not per crop).
        except Exception:  # noqa: BLE001
            pass
        num = q.get("number")
        name = f"q{num:03d}.png" if isinstance(num, int) and num >= 1 else f"qx{saved:03d}.png"
        Image.open(io.BytesIO(bb)).convert("RGB").save(os.path.join(out_dir, name))
        saved += 1
    print(f"saved {saved} crops -> {out_dir}")
    print(f"total {time.time()-t0:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
