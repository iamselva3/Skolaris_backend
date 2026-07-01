"""Background / watermark lift — remove a faint brand watermark, tint, or light background that the
repeated-chrome and small-diagonal-watermark removers miss (e.g. a centered "SKOLARIS"/star logo behind
the questions), WITHOUT ever touching content, on any paper.

SCOPE + the universal principle. A watermark or background you can still READ THE QUESTIONS THROUGH is,
by necessity, LIGHTER than the printed ink — otherwise the text would be illegible. So "remove any
background" on a real, readable paper means "remove anything lighter than the ink", and that is exactly
what this does: it whitens pixels above the content level and keeps every darker pixel (text, lines,
stipple) byte-for-byte. Measured separation on real papers: ink < 110, a gap, watermark/tint 150-232,
white > 232. This covers a LIGHT watermark, a gray tint, a light gradient, a colored-but-light band —
all removed; all content kept.

Content safety (absolute): the lift only ever turns LIGHT pixels white. A pixel darker than `_INK_MAX`
is content and is left exactly as-is — no stroke can be erased or altered. The deliberate, SAFE failure
mode is a background DARKER than the ink (very low contrast, barely readable — not a real question
paper): it is simply KEPT rather than risk erasing the dark text that overlaps it ("when uncertain, keep
pixels"). Tried and rejected: local background-normalization (morphological close / dilation + divide) —
it removes a light watermark but either leaves a residue or, on a dark dense-text region, erases text; an
absolute light-pixel lift is both cleaner on the real case and provably content-safe.

Self-disabling: a clean page (almost no faint-gray pixels) fails the presence gate and is an exact no-op,
so this is safe to call on every page/crop. cv2/numpy guarded; never raises.
"""
from __future__ import annotations

try:
    import cv2
    import numpy as np

    _OK = True
except Exception:  # noqa: BLE001
    _OK = False

_INK_MAX = 150           # a pixel this dark or darker is CONTENT — never touched (protects gray strokes too)
_LIFT_FROM = 165         # whiten pixels at/above this (the faint watermark/tint band + near-white)
_BAND_LO, _BAND_HI = 165, 234   # the watermark's own band — used only to DETECT presence
_PRESENT_FRAC = 0.10     # a light background is present when ≥ this share of the image sits in the band


def has_background(gray) -> bool:
    """True when a meaningful light watermark/tint occupies the image (the presence gate)."""
    if not _OK or gray is None:
        return False
    return float(((gray >= _BAND_LO) & (gray <= _BAND_HI)).mean()) >= _PRESENT_FRAC


def lift_array(img):
    """Remove a light watermark/background from a BGR/gray image. Returns (out, changed); a clean image
    (no faint background) is an exact no-op.

    Content-safe by CONSTRUCTION: a pixel is whitened only when it is light (>= _LIFT_FROM) AND lies
    OUTSIDE a small halo grown around every dark/content pixel — so text, diagram strokes, and their
    anti-aliased edges are never touched, while a faint diagonal watermark/swoosh/tint sitting in the
    EMPTY areas (which the old 10%-of-page presence gate missed when the mark was small, e.g. the ~1.6%
    SK swoosh behind a single question) is cleared. Self-disabling: a blank image, or one with no light
    background away from content, is an exact no-op."""
    if not _OK or img is None:
        return img, False
    arr = img if img.ndim == 3 else cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    gray = cv2.cvtColor(arr, cv2.COLOR_BGR2GRAY)
    dark = (gray < _INK_MAX).astype("uint8")        # content (text / strokes / stipple)
    if float(dark.mean()) < 1e-4:                    # essentially blank ⇒ nothing to protect or clean
        return img, False
    halo = cv2.dilate(dark, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))  # protect only the 1px
    #     anti-aliased edge around a stroke — a wider halo would also protect a grey HIGHLIGHT band that
    #     sits right against the words (q165-style), leaving it in the crop.
    bg_light = (gray >= _LIFT_FROM) & (halo == 0)    # light pixel, not on/adjacent to any content
    if float(bg_light.mean()) < 0.002:               # no liftable background ⇒ exact no-op
        return img, False
    out = arr.copy()
    out[bg_light] = 255
    return out, True


def lift_png(png_bytes: bytes):
    """Remove a light watermark/background from PNG bytes. Returns (png_bytes, changed); originals on any problem."""
    if not _OK or not png_bytes:
        return png_bytes, False
    try:
        arr = cv2.imdecode(np.frombuffer(png_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
        if arr is None:
            return png_bytes, False
        out, changed = lift_array(arr)
        if not changed:
            return png_bytes, False
        ok, enc = cv2.imencode(".png", out)
        return (enc.tobytes(), True) if ok else (png_bytes, False)
    except Exception:  # noqa: BLE001
        return png_bytes, False
