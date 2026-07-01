"""
RapidOCR adapter — the GRACEFUL FALLBACK for scanned/printed OCR when PaddleOCR is unavailable.

RapidOCR is a PaddleOCR port that runs on ONNXRuntime (which ships Python-3.13 wheels), with bundled
detection + recognition + angle models and NO paddlepaddle/torch dependency. So when the primary engine
can't be installed in the runtime, the router falls back here instead of degrading the page — the
document still validates. Same contract as paddle_adapter: a missing backend raises EngineUnavailable
(so the router can fall further / KEEP PIXELS), and pixel boxes are mapped to PDF points via `scale`.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, List, Optional

from .models import EngineUnavailable, OcrToken, Region

if TYPE_CHECKING:
    import numpy as np

_RAPID = None
_TRIED = False
_ERR = ""


def rapid_available() -> bool:
    """True if rapidocr_onnxruntime imports + a singleton builds. Probed once, cached."""
    global _RAPID, _TRIED, _ERR
    if _TRIED:
        return _RAPID is not None
    _TRIED = True
    try:
        from rapidocr_onnxruntime import RapidOCR  # type: ignore

        _RAPID = RapidOCR()
    except Exception as e:  # noqa: BLE001
        _RAPID = None
        _ERR = str(e)
    return _RAPID is not None


def extract_printed(
    image: "np.ndarray",
    index: int,
    scale: float,
    regions: Optional[List[Region]] = None,
) -> List[OcrToken]:
    """Recognise text with RapidOCR. If `regions` is given, OCR only those crops (one engine per region);
    else OCR the whole image. Pixel boxes → PDF points via `scale`. Raises EngineUnavailable if RapidOCR
    is not installed — the router degrades the page (KEEP PIXELS)."""
    if not rapid_available():
        raise EngineUnavailable("rapidocr", _ERR)

    crops: List[tuple] = []  # (sub_image, offset_x_px, offset_y_px)
    if regions:
        for r in regions:
            x0, y0 = int(r.x0 / scale), int(r.y0 / scale)
            x1, y1 = int(r.x1 / scale), int(r.y1 / scale)
            sub = image[max(0, y0):max(0, y1), max(0, x0):max(0, x1)]
            if sub.size:
                crops.append((sub, x0, y0))
    else:
        crops.append((image, 0, 0))

    tokens: List[OcrToken] = []
    for sub, off_x, off_y in crops:
        result, _elapse = _RAPID(sub)  # type: ignore[misc]  -> [[box(4pts), text, score], ...]
        for entry in (result or []):
            box, text, score = entry[0], entry[1], entry[2]
            txt = (text or "").strip()
            if not txt:
                continue
            xs = [p[0] + off_x for p in box]
            ys = [p[1] + off_y for p in box]
            lx0, ly0 = min(xs) * scale, min(ys) * scale
            lx1, ly1 = max(xs) * scale, max(ys) * scale
            line_w = max(1.0, lx1 - lx0)
            conf = float(score) if score is not None else 0.5
            # SPLIT the line into WORD-LEVEL tokens (the structure engine expects words, like the digital
            # PyMuPDF path). RapidOCR returns whole lines, so a glued "1. A capacitor…" would hide the
            # leading question number from the marker detector. Estimate each word's x-span proportional
            # to its character offset within the line box — the leading "1." lands at the left margin, so
            # the standalone-number marker logic works identically for scanned and digital pages.
            words = txt.split()
            total_chars = max(1, len(txt))
            char_pos = 0
            for w in words:
                f0 = char_pos / total_chars
                f1 = (char_pos + len(w)) / total_chars
                tokens.append(
                    OcrToken(
                        text=w,
                        x0=lx0 + f0 * line_w,
                        y0=ly0,
                        x1=lx0 + f1 * line_w,
                        y1=ly1,
                        page=index,
                        conf=conf,
                        source="rapidocr",
                    )
                )
                char_pos += len(w) + 1  # +1 for the separating space
    return tokens
