"""
DIGITAL extractor — PyMuPDF text layer → OcrToken[]. No model, no CV, exact boxes.

This is the whole OCR for born-digital pages and the text-layer half of mixed pages: PyMuPDF gives
the exact glyph boxes the PDF was authored with, so for digital papers Python OCR is both faster AND
more accurate than any raster OCR. Word boxes come back in PDF points (top-left origin), the same
coordinate space the structure engine + crop builder use, so NO rescaling is ever needed.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, List

from .models import OcrToken

if TYPE_CHECKING:
    import fitz


def extract_digital(page: "fitz.Page", index: int) -> List[OcrToken]:
    """All real words on a digital/mixed page's text layer, reading order preserved by PyMuPDF
    (sorted by block, line, word). Whitespace-only tokens are dropped."""
    tokens: List[OcrToken] = []
    # sort=True → blocks/lines/words returned top-to-bottom, left-to-right (natural reading order).
    for w in page.get_text("words", sort=True):
        text = w[4].strip()
        if not text:
            continue
        tokens.append(
            OcrToken(
                text=text,
                x0=float(w[0]),
                y0=float(w[1]),
                x1=float(w[2]),
                y1=float(w[3]),
                page=index,
                conf=1.0,        # authored glyphs — not a probabilistic read
                source="pymupdf",
            )
        )
    return tokens
