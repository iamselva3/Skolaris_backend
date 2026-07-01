"""Leading question-number / badge eraser — pixel-level, OCR-independent, content-safe.

The crop owns CONTENT; the UI owns NUMBERING, so the question number must not appear in the delivered
crop. The token-based eraser (number_box) handles a PLAIN "8." marker, but a DECORATIVE badge — a
circled "143", a boxed number, an "NM" tag, a handwritten mark — is often NOT captured as a clean
number token, so it survives in the crop AND slips past the box-based visibility check.

This finds the leading marker STRUCTURALLY: a question crop begins with a small, isolated inked blob
at the TOP-LEFT (the number / badge), then a WHITESPACE GAP, then the stem. That shape is the marker
whatever its styling — so a circle/box/badge/handwritten number is caught exactly like a plain digit.
It whitens ONLY that blob, and ONLY when the isolation holds (small width + a real gap + content after
the gap); a stem that starts with wide continuous text has no such blob ⇒ NO-OP (never eats content).

Universal: no PDF/institute/size constants — every threshold is a fraction of the crop's own median
line height / width. numpy + PIL guarded; never raises.
"""
from __future__ import annotations

import io
from typing import Optional, Tuple

try:
    import numpy as np  # type: ignore
    from PIL import Image  # type: ignore

    _OK = True
except Exception:  # noqa: BLE001
    _OK = False

Box = Tuple[int, int, int, int]  # x0, y0, x1, y1 in crop-local pixels

_INK = 200            # luminance below ⇒ ink
_MAX_W_LINES = 5.0    # a number/badge is at most this many TEXT line-heights wide (a circle ≈ 4–5)
_MAX_W_FRAC = 0.16    # …and never more than this fraction of the crop width
_MAX_H_LINES = 4.0    # …and at most this many line-heights tall (a circled badge spans ~2–3 lines)
_MERGE_GAP_FRAC = 0.22  # column gaps smaller than this × line-height are INSIDE one token (digits)
_INDENT_GAP_FRAC = 0.7  # for a SINGLE-LINE number, the gap AFTER it must be a real INDENT this big
                        # (× line-height) — a word space is smaller, so a stem word is never a marker
# A BADGE (circled / boxed number, an "NM" tag) is a COMPACT, MULTI-LINE-TALL, roughly-square inked
# block at the top-left — unlike single-line body text and unlike a large figure. It often sits TIGHT
# against the stem (small gap), so it is accepted on SHAPE, not on an indent gap.
_BADGE_MIN_H_LINES = 1.5   # taller than this many text lines ⇒ not a one-line word ⇒ a badge/box
_BADGE_MAX_H_FRAC = 0.45   # …but a badge is small: at most this fraction of the crop height (a figure is bigger)
_BADGE_ASPECT_LO = 0.45    # height/width within [lo, hi] ⇒ compact/square (a circle/box), not a thin bar
_BADGE_ASPECT_HI = 3.0
_PAD_FRAC = 0.25      # whiten a small margin around the marker (clear the circle/badge ring)


def _line_height(ink: "np.ndarray") -> float:
    """Median TEXT line height (document-derived). Runs taller than a fraction of the crop are figures
    / a circled badge, NOT a text line, so they are excluded — otherwise a tall badge inflates the
    estimate and breaks every line-relative threshold."""
    H = ink.shape[0]
    rows = ink.any(axis=1)
    runs, cur = [], 0
    for r in rows:
        if r:
            cur += 1
        elif cur:
            runs.append(cur); cur = 0
    if cur:
        runs.append(cur)
    text_runs = sorted(r for r in runs if 4 <= r <= 0.18 * H)
    if text_runs:
        return float(text_runs[len(text_runs) // 2])
    if runs:
        runs.sort()
        return float(min(runs[len(runs) // 2], 0.12 * H))
    return max(8.0, 0.045 * H)


def available() -> bool:
    return _OK


def detect_leading_marker(img) -> Optional[Box]:
    """Box of the leading number/badge, or None when the crop has no isolated leading marker."""
    if not _OK or img is None:
        return None
    arr = np.asarray(img.convert("L"))
    if arr.size == 0:
        return None
    ink = arr < _INK
    rows = ink.any(axis=1)
    if not rows.any():
        return None
    first_row = int(np.argmax(rows))
    H, W = ink.shape
    lh = _line_height(ink)
    band_h = int(min(H - first_row, _MAX_H_LINES * lh))
    if band_h < 2:
        return None
    band = ink[first_row:first_row + band_h]
    col = band.any(axis=0)
    if not col.any():
        return None

    # Column runs of ink in the top band, then MERGE runs separated by tiny gaps (inside one token —
    # e.g. the digits of "143", or "8" and its dot) so the marker is the WHOLE number/badge.
    runs = []
    x = 0
    while x < W:
        if col[x]:
            s = x
            while x < W and col[x]:
                x += 1
            runs.append([s, x])
        else:
            x += 1
    if len(runs) < 2:
        return None  # need the marker AND content after it
    merge_gap = max(2, int(_MERGE_GAP_FRAC * lh))
    merged = [runs[0]]
    for s, e in runs[1:]:
        if s - merged[-1][1] <= merge_gap:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    if len(merged) < 2:
        return None  # everything merged into one blob (continuous stem) ⇒ no isolated marker

    first_col, marker_x1 = merged[0]
    gap_after = merged[1][0] - marker_x1
    marker_w = marker_x1 - first_col

    # Early reject WIDE blobs (a figure / a continuous stem line): a number or badge is a small corner
    # element. The tight line-height width cap is applied per-branch below (a PLAIN number is narrower
    # than a circled BADGE, which can be several text-lines wide).
    if marker_w <= 0 or marker_w > _MAX_W_FRAC * W:
        return None

    # Vertical extent of the marker = the contiguous inked block in ITS OWN columns (captures the full
    # circle/badge height even if taller than the band). Start at the first inked row WITHIN the marker
    # columns (the digit may sit a few px below the stem's first row), require it to align with the top
    # content (a leading marker, not something lower), then walk down until a blank row (line spacing)
    # ends it — so a second stem line under the number is never swallowed. Capped to a few line-heights.
    colslice = ink[:, first_col:marker_x1].any(axis=1)
    inked_rows = np.argwhere(colslice[:min(H, first_row + int(_MAX_H_LINES * lh))]).ravel()
    inked_rows = inked_rows[inked_rows >= first_row]
    if inked_rows.size == 0 or inked_rows[0] > first_row + lh:
        return None  # nothing inked at the top of the marker columns ⇒ not a leading marker
    # Walk the contiguous inked block down. A blank row (line spacing) ends it — so a plain number stops
    # at its own row and a second stem line below is never swallowed. The cap is the BADGE height bound
    # (not a few line-heights) so a tall circled badge is captured WHOLE, not clipped to half.
    y0 = int(inked_rows[0])
    y1 = y0
    cap = first_row + int(_BADGE_MAX_H_FRAC * H)
    y = y0
    while y < min(H, cap) and colslice[y]:
        y1 = y + 1
        y += 1
    if y1 <= y0:
        return None
    marker_h = y1 - y0

    # ACCEPTANCE — two shapes of a leading question number:
    #  • BADGE/BOX: a COMPACT, MULTI-LINE-TALL, roughly-square block (a circled/boxed number + tag). It
    #    often hugs the stem (small gap), so it is accepted on SHAPE — never the indent. Body text is one
    #    line tall; a figure is wider/taller than a badge, so both are excluded.
    #  • PLAIN NUMBER: a SINGLE-LINE token ("8." / "146.") followed by a real INDENT gap (a word space is
    #    smaller, so a stem word is rejected).
    aspect = marker_h / max(1, marker_w)
    is_badge = (
        marker_h >= _BADGE_MIN_H_LINES * lh
        and marker_h <= _BADGE_MAX_H_FRAC * H
        and _BADGE_ASPECT_LO <= aspect <= _BADGE_ASPECT_HI
    )
    is_plain_number = (
        marker_h < _BADGE_MIN_H_LINES * lh
        and marker_w <= _MAX_W_LINES * lh           # a one-line number is narrow (not a wide heading)
        and gap_after >= max(5, int(_INDENT_GAP_FRAC * lh))
    )
    if not (is_badge or is_plain_number):
        return None

    pad = int(_PAD_FRAC * lh)
    return (max(0, first_col - pad), max(0, y0 - pad),
            min(W, marker_x1 + pad), min(H, y1 + pad))


def erase(img) -> Tuple["Image.Image", bool, Optional[Box]]:
    """Whiten the leading marker if present. Returns (image, erased, box). NO-OP when none found."""
    if not _OK or img is None:
        return img, False, None
    box = detect_leading_marker(img)
    if box is None:
        return img, False, None
    out = img.convert("RGB")
    a = np.asarray(out).copy()
    x0, y0, x1, y1 = box
    a[y0:y1, x0:x1, :] = 255
    return Image.fromarray(a, "RGB"), True, box


def erase_png(png: bytes) -> Tuple[bytes, bool]:
    """Erase the leading marker on PNG bytes → PNG bytes. Best-effort; originals on any error."""
    if not _OK or not png:
        return png, False
    try:
        img = Image.open(io.BytesIO(png)).convert("RGB")
        out, erased, _ = erase(img)
        if not erased:
            return png, False
        buf = io.BytesIO()
        out.save(buf, format="PNG")
        return buf.getvalue(), True
    except Exception:  # noqa: BLE001
        return png, False


def present(img) -> bool:
    """True when an isolated leading number/badge is still visible in the crop (validation signal)."""
    return detect_leading_marker(img) is not None
