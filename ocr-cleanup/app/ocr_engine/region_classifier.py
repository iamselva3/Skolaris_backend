"""
REGION CLASSIFIER — split a scanned page render into PRINTED vs HANDWRITTEN regions so each is read
by exactly ONE engine (printed → PaddleOCR, handwritten → TrOCR). Never the whole page to TrOCR.

Approach (CV, guarded): morphologically join glyphs into text-line blobs, then for each blob measure
how machine-regular it is. Printed text has near-constant stroke width and a flat baseline; handwriting
has high stroke-width variance and an irregular baseline. We use stroke-width coefficient-of-variation
(via the distance transform of the inked mask) as the primary signal. The default is conservative:
unless a region is CLEARLY irregular it is PRINTED — sending printed text to TrOCR is worse than
sending tidy handwriting to Paddle, and the structure engine still validates downstream.

Degrades cleanly: with no cv2/numpy, the whole page is returned as one PRINTED region (Paddle handles
it) — handwriting routing simply turns on once the CV stack is present (it already is in this sidecar).
This is a tunable heuristic, not a trained classifier; precision on handwriting is a Phase-2 tuning task.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, List

from .models import Region, RegionKind

if TYPE_CHECKING:
    import numpy as np

# Stroke-width coefficient of variation above which a text block reads as handwritten. Conservative
# (high) on purpose — printed text typically sits well under ~0.45; handwriting runs higher.
HANDWRITTEN_SWCV = 0.62
# Ignore specks: a region must be at least this tall/wide in pixels to be a real text block.
MIN_BLOCK_PX = 14


def _cv():
    """Return (cv2, np) or (None, None) if the CV stack is absent."""
    try:
        import cv2
        import numpy as np

        return cv2, np
    except Exception:  # noqa: BLE001
        return None, None


def _stroke_width_cov(cv2, np, mask: "np.ndarray") -> float:
    """Coefficient of variation (std/mean) of stroke half-widths inside an inked mask.
    Uses the distance transform: each inked pixel's distance to the nearest background pixel
    approximates the local stroke half-width. Uniform (printed) → low CoV; variable (hand) → high."""
    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 3)
    # float64 — summing a full-page mask's distances overflows float32 (→ NaN). Guard non-finite.
    vals = dist[dist > 0].astype(np.float64)
    if vals.size < 20:
        return 0.0
    mean = float(vals.mean())
    std = float(vals.std())
    if not (mean > 1e-6) or not np.isfinite(mean) or not np.isfinite(std):
        return 0.0
    return std / mean


def detect_regions(image: "np.ndarray", scale: float) -> List[Region]:
    """Segment text-line regions from a page render and tag each PRINTED/HANDWRITTEN.
    `image` is the rendered page (grayscale or BGR); `scale` = PDF points per pixel. Returns regions
    in PDF points. If the CV stack is unavailable, returns one PRINTED region covering the whole page."""
    cv2, np = _cv()
    if cv2 is None:
        h, w = image.shape[:2]
        return [Region(0.0, 0.0, w * scale, h * scale, RegionKind.PRINTED, conf=0.0)]

    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    # Binarize to an inked mask (text = white) — Otsu, inverted so glyphs are foreground.
    _, ink = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    # Join glyphs into text lines: wide horizontal close, then a light vertical close for descenders.
    line_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (25, 3))
    lines = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, line_kernel)
    contours, _ = cv2.findContours(lines, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    regions: List[Region] = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        if w < MIN_BLOCK_PX or h < MIN_BLOCK_PX:
            continue
        block_ink = ink[y:y + h, x:x + w]
        swcv = _stroke_width_cov(cv2, np, block_ink)
        is_hand = swcv >= HANDWRITTEN_SWCV
        regions.append(
            Region(
                x0=x * scale,
                y0=y * scale,
                x1=(x + w) * scale,
                y1=(y + h) * scale,
                kind=RegionKind.HANDWRITTEN if is_hand else RegionKind.PRINTED,
                conf=min(1.0, swcv),
            )
        )
    if not regions:  # nothing segmented (blank/odd page) → let Paddle see the whole surface
        h, w = gray.shape[:2]
        regions.append(Region(0.0, 0.0, w * scale, h * scale, RegionKind.PRINTED, conf=0.0))
    return regions
