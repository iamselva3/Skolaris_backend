"""RapidOCR page re-OCR — replace poor platform-OCR (Tesseract) tokens with RapidOCR tokens on SCANNED
pages, so the structure engine reasons over a clean word stream.

On a scanned paper the platform OCR (Tesseract) drops half the question numbers AND many option labels —
the structure engine then literally has no markers/options to own (10 of 20 questions on the reference
scan). RapidOCR reads the SAME page render far better (18 of 20). This module re-OCRs each page's embedded
render and rebuilds the word list, so the downstream pipeline (markers → ownership → crops) runs on the
better tokens with NO change to its logic.

Gated by STRUCTURE_RAPIDOCR (default OFF — it adds ~7-12s/page). Enable per scanned document. A page with
no render, or when RapidOCR is unavailable, is left on its original tokens (best-effort; never raises).
"""
from __future__ import annotations

import base64
import io
from typing import List

from .models import PageInput, WordBox

_RAPID = None
_TRIED = False


def available() -> bool:
    global _RAPID, _TRIED
    if _TRIED:
        return _RAPID is not None
    _TRIED = True
    try:
        from rapidocr_onnxruntime import RapidOCR  # type: ignore
        _RAPID = RapidOCR()
    except Exception:  # noqa: BLE001 — RapidOCR not installed ⇒ silently keep platform tokens
        _RAPID = None
    return _RAPID is not None


def _ocr_words(img) -> List[WordBox]:
    """RapidOCR returns LINE boxes; split each line into proportional pseudo-words so the marker / option /
    column detectors see word-level tokens (same shaping as pdf_direct_extract)."""
    res, _ = _RAPID(img)
    out: List[WordBox] = []
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
            out.append(WordBox(text=p, x0=float(cur), y0=float(ly0), x1=float(wx1), y1=float(ly1),
                               conf=float(_score or 0.0)))
            cur += span * frac
    return out


def reocr_pages(pages: List[PageInput]) -> int:
    """Re-OCR every page that carries a render, REPLACING its words with RapidOCR words. Returns the number
    of pages re-OCR'd. Best-effort: a page whose render fails to decode/OCR keeps its original words."""
    if not available():
        return 0
    try:
        import numpy as np  # type: ignore
        from PIL import Image  # type: ignore
    except Exception:  # noqa: BLE001
        return 0
    done = 0
    for p in pages:
        b64 = getattr(p, "image_base64", None)
        if not b64:
            continue
        try:
            img = np.asarray(Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB"))
            words = _ocr_words(img)
            if words:
                p.words = words
                done += 1
        except Exception:  # noqa: BLE001 — one bad page never fails the document
            continue
    return done
