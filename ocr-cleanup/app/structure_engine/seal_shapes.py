"""Seal/badge SHAPE detection — the RECALL layer for question-number badges.

`badge_detector.py` reads the NUMBER inside a seal (precision: only badges whose inverted seal OCRs to a
digit survive — ~14 of ~33 on a real paper). For accurate COUNT + OWNERSHIP we also need the seals the
OCR could NOT read: a seal is a question START whether or not its digit is legible. This module finds
EVERY seal by SHAPE — a SOLID-FILL (high ink density), COMPACT, roughly-SQUARE connected component sized
like a number block (a small fraction of the page width), in the content band (below header / above
footer). Returns pixel boxes; the caller injects the ones not already covered by a read number as
NUMBERLESS markers (the sequence reconciler assigns the value).

Universal: every threshold is a ratio of the page's own geometry — no PDF/institute/DPI constant. It
fires only on solid seals, so a plain-text paper (no seals) is a NO-OP. cv2 + numpy, guarded; never raises.
"""
from __future__ import annotations

from typing import List, Tuple

try:
    import cv2  # type: ignore
    import numpy as np  # type: ignore

    _OK = True
except Exception:  # noqa: BLE001
    _OK = False

Box = Tuple[int, int, int, int]  # x0, y0, x1, y1 in render-pixel coords

_INK_T = 110          # luminance below ⇒ ink (a seal is near-solid dark)
_FILL_MIN = 0.42      # dark pixels / bbox area — SOLID, unlike thin-stroke text
_ASPECT_LO = 0.6      # height/width — roughly square (a circle/box), not a line/word
_ASPECT_HI = 1.9
_W_MIN_FRAC = 0.024   # a seal is at least this fraction of page width …
_W_MAX_FRAC = 0.060   # … and at most this (bigger ⇒ a figure; smaller ⇒ a glyph)
_TOP_FRAC = 0.06      # ignore the header band …
_BOTTOM_FRAC = 0.93   # … and the footer band
_CORE_LIGHT_MIN = 0.05  # ≥ this fraction of the seal's CORE must be light (the reversed-out number) —
                        # a plain solid block (no light core) is rejected; a real seal keeps its digit


def available() -> bool:
    return _OK


def detect_seal_shapes(image, page_width: float | None = None) -> List[Box]:
    """Return the bounding boxes of seal/badge question numbers in a page render. `image` is a PIL image
    or a numpy gray/BGR array. Empty list when none (a plain-text page) or cv2 absent. `page_width` is
    accepted for call-site symmetry with badge_detector but the width is taken from the image."""
    if not _OK or image is None:
        return []
    try:
        arr = np.asarray(image)
        if arr.ndim == 3:
            arr = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
        H, W = arr.shape[:2]
        if H < 10 or W < 10:
            return []
        binimg = (arr < _INK_T).astype("uint8")
        n, _lbl, stats, _c = cv2.connectedComponentsWithStats(binimg, connectivity=8)
        w_lo, w_hi = _W_MIN_FRAC * W, _W_MAX_FRAC * W
        y_lo, y_hi = _TOP_FRAC * H, _BOTTOM_FRAC * H
        out: List[Box] = []
        for i in range(1, n):
            x, y, w, h, area = (int(stats[i][k]) for k in range(5))
            if not (w_lo <= w <= w_hi and w_lo <= h <= w_hi):
                continue
            if not (y_lo < y < y_hi):
                continue
            if area / float(max(1, w * h)) < _FILL_MIN:
                continue
            if not (_ASPECT_LO <= h / float(max(1, w)) <= _ASPECT_HI):
                continue
            # A real SEAL has a BRIGHT reversed-out NUMBER in its core; a plain solid shape (a filled
            # diagram block / bullet) does NOT. Require some light pixels in the central region — this is
            # the discriminator that keeps real seals while rejecting solid fills (no PDF-specific tuning).
            core = arr[y + h // 4: y + (3 * h) // 4, x + w // 4: x + (3 * w) // 4]
            if core.size == 0 or float((core >= 180).mean()) < _CORE_LIGHT_MIN:
                continue
            out.append((x, y, x + w, y + h))
        out.sort(key=lambda b: (b[1], b[0]))
        return out
    except Exception:  # noqa: BLE001
        return []


def erase_top_left_seal_png(png_bytes: bytes):
    """Whiten the question-number SEAL/badge ("8 NM", "143 NM" …) at a crop's TOP-LEFT — the UI owns the
    number, so the crop is content-only. Content-safe: erases ONLY a SOLID, square, bright-cored seal
    sitting in the top-left number slot; a seal elsewhere, or a crop with none, is an exact no-op. Sizing
    is in ABSOLUTE pixels (not page-fraction) because on a single-column CROP the seal is a larger share
    of the width than on the full page. `leading_marker.erase_png` handles plain/outline badges; this
    handles the SOLID dark-filled NM seal it misses. Returns (png, erased). cv2 guarded; never raises."""
    if not _OK or not png_bytes:
        return png_bytes, False
    try:
        arr = cv2.imdecode(np.frombuffer(png_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
        if arr is None:
            return png_bytes, False
        gray = cv2.cvtColor(arr, cv2.COLOR_BGR2GRAY) if arr.ndim == 3 else arr
        H, W = gray.shape[:2]
        slot_y, slot_x = 0.22 * H, 0.30 * W   # the leading number occupies the top-left corner only
        binimg = (gray < _INK_T).astype("uint8")
        n, _lbl, stats, _c = cv2.connectedComponentsWithStats(binimg, connectivity=8)
        for i in range(1, n):
            x, y, w, h, area = (int(stats[i][k]) for k in range(5))
            if (x + w / 2.0) > slot_x or (y + h / 2.0) > slot_y:
                continue  # not in the top-left number slot ⇒ leave it (content)
            if not (20 <= w <= 0.22 * W and 18 <= h <= 0.22 * W):
                continue  # a 1–3 digit number block, not a glyph or a figure. Both bounds use the crop
                #           WIDTH (the stable column dimension): a SHORT 4-5 line crop's height is tiny, so
                #           bounding height by crop-height wrongly rejected a normal ~57px seal (q98/132).
            if area / float(max(1, w * h)) < _FILL_MIN:
                continue  # SOLID seal, not thin text
            if not (_ASPECT_LO <= h / float(max(1, w)) <= _ASPECT_HI):
                continue
            core = gray[y + h // 4: y + (3 * h) // 4, x + w // 4: x + (3 * w) // 4]
            if core.size == 0 or float((core >= 180).mean()) < _CORE_LIGHT_MIN:
                continue  # a real seal has the reversed-out number (bright core)
            pad = max(2, int(0.015 * W))
            # pad left/top/bottom, but only +2px on the RIGHT — the question text starts immediately to
            # the badge's right, so a wide right pad would clip its first letter.
            arr[max(0, y - pad): min(H, y + h + pad), max(0, x - pad): min(W, x + w + 2)] = 255
            ok, enc = cv2.imencode(".png", arr)
            return (enc.tobytes(), True) if ok else (png_bytes, False)
        return png_bytes, False
    except Exception:  # noqa: BLE001
        return png_bytes, False
