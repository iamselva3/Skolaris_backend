"""Lightweight question-NUMBER recovery by re-OCR of the left margin — RapidOCR (ONNX), no torch.

The platform OCR (TS Tesseract) reliably reads CLEAN printed question numbers, but it drops them on a
poor scan and is unreliable on HANDWRITTEN numbers (e.g. a paper whose numbers were written in pen). The
question then goes MISSING and its neighbours merge. This pass re-reads ONLY the narrow left-margin band of
each column — where a question number lives — with RapidOCR (already in the repo for the seal/badge reader;
ONNXRuntime, ~tens of MB, NO torch/paddle), parses the digit it finds, and injects it as a number marker.
The structure engine's existing sequence reconciler then orders / gap-fills / demotes, so a single misread
("4" for a handwritten "41") is corrected by its neighbours rather than trusted blindly.

Design for SPEED + SAFETY:
  • runs on the MARGIN STRIP only (a column-left band), never the whole page — small images, fast;
  • optionally restricted to columns whose token markers are SPARSE (the pages that actually need it);
  • digit-only parse with a tight margin gate, so body numbers / option labels are not taken as starts;
  • additive + deduped against existing markers; the reconciler remains the authority on the final set.

Never raises (no RapidOCR / no render ⇒ no-op). Coordinates are returned in the SAME pixel space as the
word boxes (renders and words share one space), so no scaling is applied.
"""
from __future__ import annotations

import re
from typing import Any, List, Tuple

# A question number is NUMBER-FIRST ("41", "41)", "98."), so a leading "(" is NOT allowed — that is how an
# OPTION label ("(1)", "(2)") is told apart from a question number and kept out of the marker set.
_NUM_RE = re.compile(r"^(\d{1,3})\s*[.)\-:]?$")


def available() -> bool:
    try:
        from ..ocr_engine import rapid_adapter

        return rapid_adapter.rapid_available()
    except Exception:  # noqa: BLE001
        return False


def _decode(image_base64: str):
    try:
        import base64

        import numpy as np  # type: ignore
        from PIL import Image  # type: ignore
        import io

        return np.asarray(Image.open(io.BytesIO(base64.b64decode(image_base64))).convert("RGB"))
    except Exception:  # noqa: BLE001
        return None


def _upscale(arr, factor: int):
    if factor <= 1:
        return arr
    from PIL import Image  # type: ignore
    import numpy as np  # type: ignore

    im = Image.fromarray(arr).resize((arr.shape[1] * factor, arr.shape[0] * factor))
    return np.asarray(im)


def detect_margin_numbers(
    image, columns: List[Any], median_h: float, page_height: float
) -> List[Tuple[int, float, float, float, float]]:
    """Read question numbers from each column's LEFT-MARGIN band. Returns (num, x0, y0, x1, y1) in full-page
    pixel space. The band runs from a little LEFT of the column text edge to a few glyph-widths into it, over
    the page body, upscaled 2× to help a faint/handwritten digit. Only a token that is PURELY a 1–3 digit
    number (optionally trailing . ) - :) at the band LEFT is taken — a question number is the leftmost thing
    on its line, so body numbers and option labels are excluded."""
    from ..ocr_engine import rapid_adapter

    if not rapid_adapter.rapid_available():
        return []
    import numpy as np  # type: ignore

    H, W = image.shape[0], image.shape[1]
    mh = median_h if median_h and median_h > 0 else 18.0
    y_lo, y_hi = int(H * 0.08), int(H * 0.97)
    out: List[Tuple[int, float, float, float, float]] = []
    cols = columns or []
    for c in cols:
        # The question number sits in the column's LEFT MARGIN — for the RIGHT column that margin lands a
        # few glyph-heights LEFT of the column's text edge (in the inter-column gutter), so the band must
        # reach well left of `c.left` to cover it; too narrow a left edge missed every right-column number.
        bx0 = max(0, int(c.left - 6.0 * mh))
        bx1 = min(W, int(c.left + 5.0 * mh))
        if bx1 - bx0 < 8 or y_hi - y_lo < 8:
            continue
        band = image[y_lo:y_hi, bx0:bx1]
        up = _upscale(band, 2)
        try:
            res, _ = rapid_adapter._RAPID(up)  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            continue
        for entry in (res or []):
            box, text = entry[0], str(entry[1]).strip()
            m = _NUM_RE.match(text)
            if not m:
                continue
            val = int(m.group(1))
            # A question number is bounded — a 3-digit OCR read like "641"/"921" is an in-content number
            # (a coordinate / value) misread at the margin, never a question start. Cap to a sane question
            # range so such noise can't be injected as a phantom question.
            if val < 1 or val > 300:
                continue
            xs = [pt[0] for pt in box]
            ys = [pt[1] for pt in box]
            # map the upscaled-band box back to full-page pixel space
            fx0 = bx0 + min(xs) / 2.0
            fx1 = bx0 + max(xs) / 2.0
            fy0 = y_lo + min(ys) / 2.0
            fy1 = y_lo + max(ys) / 2.0
            # margin gate: a question number sits in the LEFT portion of the band (not a number deeper into
            # the line, e.g. a value inside the stem). Loosened to 0.7 — the band is now wider on the left
            # (to reach the right column's gutter number), so the number can sit a bit further into it.
            if (fx0 - bx0) > 0.7 * (bx1 - bx0):
                continue
            out.append((val, fx0, fy0, fx1, fy1))
    return out


def detect_numbers_in_region(
    image, column: Any, y0: float, y1: float, median_h: float
) -> List[Tuple[int, float, float, float, float]]:
    """Read question numbers from ONE column's left-margin band, restricted to the y-range [y0, y1] — the GAP
    region between two known questions. This is the RECOVERY-ONLY entry point: it OCRs a small band (a few
    lines tall) instead of the whole page, so handwritten OCR never runs over already-detected content. Same
    digit parse + margin gate as `detect_margin_numbers`. Returns (num, x0, y0, x1, y1) in full-page pixel
    space. No render / no RapidOCR ⇒ []."""
    from ..ocr_engine import rapid_adapter

    if not rapid_adapter.rapid_available() or column is None:
        return []
    import numpy as np  # type: ignore

    H, W = image.shape[0], image.shape[1]
    mh = median_h if median_h and median_h > 0 else 18.0
    bx0 = max(0, int(column.left - 6.0 * mh))
    bx1 = min(W, int(column.left + 5.0 * mh))
    by0 = max(0, int(y0))
    by1 = min(H, int(y1))
    if bx1 - bx0 < 8 or by1 - by0 < 8:
        return []
    band = image[by0:by1, bx0:bx1]
    up = _upscale(band, 2)
    try:
        res, _ = rapid_adapter._RAPID(up)  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        return []
    out: List[Tuple[int, float, float, float, float]] = []
    for entry in (res or []):
        box, text = entry[0], str(entry[1]).strip()
        m = _NUM_RE.match(text)
        if not m:
            continue
        val = int(m.group(1))
        if val < 1 or val > 300:
            continue
        xs = [pt[0] for pt in box]
        ys = [pt[1] for pt in box]
        fx0 = bx0 + min(xs) / 2.0
        fx1 = bx0 + max(xs) / 2.0
        fy0 = by0 + min(ys) / 2.0
        fy1 = by0 + max(ys) / 2.0
        if (fx0 - bx0) > 0.7 * (bx1 - bx0):
            continue
        out.append((val, fx0, fy0, fx1, fy1))
    return out
