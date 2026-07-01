"""
BADGE NUMBER DETECTOR (pixel-based — sees what OCR tokens cannot).

A question number printed inside a dark SEAL / BADGE (a notary-style starburst, a filled circle, a
"NM"-tagged stamp) is WHITE-on-BLACK, so Tesseract reads NOTHING from it (`OCR=NO`) and the token-based
marker detection — TS's `detectLeadingMarker` AND Python's marker_extractor — both miss it. The question
then shows as MISSING and its content is absorbed into the previous question.

This detector works on PIXELS: it finds dark blobs in the left margin that contain a bright inner core
(white text on a dark seal), INVERTS them (white-on-black → black-on-white), and OCRs the result. A blob
that yields a NUMBER is a badge; its value is injected as a question-number marker so the normal
ownership/sequence logic counts it like any other question. Pixel-validated on real seals (reads "132").

cv2/numpy guarded; OCR via the same RapidOCR singleton used for scanned pages. No-op without the CV stack.
"""
from __future__ import annotations

from typing import List, Optional, Tuple

try:
    import cv2
    import numpy as np

    _CV = True
except Exception:  # noqa: BLE001
    _CV = False


def _ocr_number(crop_bgr) -> Optional[Tuple[int, str]]:
    """Invert + upscale + OCR a candidate badge crop; return (value, raw_text) if it reads a number."""
    import re

    from ..ocr_engine.rapid_adapter import rapid_available

    if not rapid_available():
        return None
    from ..ocr_engine import rapid_adapter

    inv = cv2.bitwise_not(crop_bgr)  # white-on-black seal → black-on-white digits
    up = cv2.resize(inv, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
    result, _ = rapid_adapter._RAPID(up)  # type: ignore[attr-defined]
    best: Optional[Tuple[int, str]] = None
    for entry in (result or []):
        text = str(entry[1])
        for d in re.findall(r"\d+", text):
            v = int(d)
            if 1 <= v <= 999:
                # prefer the longest digit run (the question number, not a stray)
                if best is None or len(d) > len(str(best[0])):
                    best = (v, text)
    return best


def detect_badges(image, page_width: float) -> List[dict]:
    """Find badge question-numbers on a page render. Returns [{x0,y0,x1,y1,number} ...] in PIXEL space.

    A badge is a DARK blob in the left margin (where numbers live) with a BRIGHT inner core (the white
    number) that, when inverted, OCRs to a number. The OCR-reads-a-number test is the real discriminator,
    so blob detection can stay permissive without false badges (a plain dark figure yields no number)."""
    if not _CV or image is None:
        return []
    img = image if image.ndim == 3 else cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    left_margin = w * 0.30  # badges sit at the question-number margin
    # Connected components on the RAW dark mask (NO morphological close — closing merges a seal into the
    # surrounding page content; the seal is already a single solid dark blob).
    dark = (gray < 80).astype(np.uint8)
    n, _lab, stats, _cent = cv2.connectedComponentsWithStats(dark, connectivity=8)
    out: List[dict] = []
    for i in range(1, n):
        x, y, bw, bh, area = (int(stats[i, k]) for k in range(5))
        if x > left_margin or not (18 < bw < 130 and 18 < bh < 130):
            continue
        if not (0.45 < bw / max(1, bh) < 2.2):  # compact (a seal/badge), not a bar / rule / line
            continue
        sub = gray[y:y + bh, x:x + bw]
        if sub.size == 0:
            continue
        # a seal is mostly dark with a BRIGHT inner core (the white number) — both must be present
        if float((sub < 80).mean()) < 0.25 or float((sub > 170).mean()) < 0.06:
            continue
        pad = 3
        crop = img[max(0, y - pad):min(h, y + bh + pad), max(0, x - pad):min(w, x + bw + pad)]
        hit = _ocr_number(crop)
        if hit is not None:
            out.append({"x0": float(x), "y0": float(y), "x1": float(x + bw), "y1": float(y + bh), "number": hit[0]})
    # dedup — the same badge can yield two overlapping components; keep ONE per number (topmost).
    seen: dict = {}
    for b in sorted(out, key=lambda b: b["y0"]):
        seen.setdefault(b["number"], b)
    return list(seen.values())
