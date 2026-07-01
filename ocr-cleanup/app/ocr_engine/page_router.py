"""
PAGE ROUTER — decide, per page, which OCR path runs. This is the routing engine the architecture
demands be built FIRST: it never runs an engine speculatively, it first proves what a page IS.

Signal (all from PyMuPDF, no model): a born-digital page carries a real text layer — extractable
words with positions and actual characters. A scanned page is a raster image with no/garbage text
layer. A mixed page has both a text layer AND a large embedded raster (e.g. a digital paper with a
scanned figure/insert). The decision is evidence-based and value-free — no PDF names, no hardcoding.

    DIGITAL : has a real text layer, little raster coverage          → PyMuPDF whole page
    MIXED   : has a real text layer AND large raster region(s)       → PyMuPDF text + region OCR
    SCANNED : no real text layer, but a large raster covers the page → region split → Paddle/TrOCR
    EMPTY   : neither text nor raster                                → no tokens, flagged
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from .models import PageKind

if TYPE_CHECKING:  # fitz is a runtime dep of the sidecar but keep the type import lazy
    import fitz

# A page needs at least this many real text-layer characters to count as having a text layer.
# Below this, stray metadata/garbage in a scanned PDF's text layer can't masquerade as digital.
MIN_DIGITAL_CHARS = 60
# Fraction of page area a raster image must cover to be treated as a real scanned surface (vs a
# small logo/decoration on an otherwise digital page).
SCANNED_IMAGE_COVERAGE = 0.55
# A digital page with raster coverage above this is treated as MIXED (text + a big embedded image).
MIXED_IMAGE_COVERAGE = 0.20
# When there is NO text layer, the definitive scanned-vs-empty signal is rendered ink: a real scan
# (even a tiled/sliced one, where no single image tile covers the page) shows meaningful ink; a truly
# blank page renders near-zero. Fraction of dark pixels in a low-DPI thumbnail above which → SCANNED.
MIN_SCANNED_INK = 0.008
_THUMB_DPI = 50


def _text_layer_chars(page: "fitz.Page") -> int:
    """Count real (non-whitespace) characters in the extractable text layer."""
    chars = 0
    for w in page.get_text("words"):
        # w = (x0, y0, x1, y1, "text", block, line, word_no)
        chars += len(w[4].strip())
    return chars


def _raster_coverage(page: "fitz.Page") -> float:
    """Largest fraction of the page covered by a single embedded raster image (0..1).

    Uses the placement rectangles, not just the XObject list, so a tiled/streamed scan and a small
    corner logo are told apart. Best-effort: any extraction hiccup yields 0.0 (treated as no raster)."""
    rect = page.rect
    page_area = float(rect.width) * float(rect.height)
    if page_area <= 0:
        return 0.0
    best = 0.0
    try:
        for info in page.get_image_info():  # placement-aware, includes bbox in page space
            bbox = info.get("bbox")
            if not bbox:
                continue
            w = max(0.0, float(bbox[2]) - float(bbox[0]))
            h = max(0.0, float(bbox[3]) - float(bbox[1]))
            best = max(best, (w * h) / page_area)
    except Exception:  # noqa: BLE001 — degrade to "no measurable raster"
        return 0.0
    return min(best, 1.0)


def _thumb_ink_ratio(page: "fitz.Page") -> float:
    """Fraction of dark pixels in a low-DPI render (0..1). The definitive scanned-vs-empty signal when
    there is no text layer: robust to tiled/sliced scans and vector-drawn content that the image list
    under-reports. Best-effort — any render hiccup yields 0.0 (treated as blank)."""
    try:
        import numpy as np

        pix = page.get_pixmap(dpi=_THUMB_DPI, alpha=False)
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        gray = img[:, :, 0] if pix.n < 3 else np.dot(img[:, :, :3], [0.299, 0.587, 0.114])
        return float((gray < 200).mean())
    except Exception:  # noqa: BLE001
        return 0.0


def classify_page(page: "fitz.Page") -> PageKind:
    """Route ONE page. Evidence-based, no hardcoded coordinates/names/thresholds-per-document."""
    chars = _text_layer_chars(page)
    has_text_layer = chars >= MIN_DIGITAL_CHARS

    if has_text_layer:
        # A real text layer alongside a large embedded raster ⇒ mixed; otherwise a clean digital page.
        return PageKind.MIXED if _raster_coverage(page) >= MIXED_IMAGE_COVERAGE else PageKind.DIGITAL

    # No usable text layer: decide scanned-vs-empty by ACTUAL rendered ink, not the image list (a tiled
    # scan has many sub-page tiles and would otherwise read as empty). Real content ⇒ SCANNED; truly
    # blank ⇒ EMPTY. Never guess content where there is none.
    return PageKind.SCANNED if _thumb_ink_ratio(page) >= MIN_SCANNED_INK else PageKind.EMPTY
