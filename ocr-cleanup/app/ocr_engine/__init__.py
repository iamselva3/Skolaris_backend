"""
SKOLARIS Python OCR Engine — the FIRST stage of the single Python document engine.

Architecture (locked 2026-06-20): Python owns the COMPLETE document lifecycle. TS is
infrastructure only (upload / API / auth / queue / Prisma / storage / persistence). This
package is the OCR ROUTER + per-engine adapters that turn an uploaded document into the
unified token stream the existing Python Document Engine (`app.structure_engine`) consumes:

    Upload (TS) → [this package] OCR router → tokens → structure_engine → crops → deliver → TS stores

ROUTING IS MANDATORY AND EXCLUSIVE — never run all three engines on a page:
    • DIGITAL page  → PyMuPDF text layer        (exact boxes, zero model, already installed)
    • SCANNED page  → layout split → PRINTED regions → PaddleOCR
                                   → HANDWRITTEN regions → TrOCR
    • MIXED page    → PyMuPDF for the text layer + region OCR for the image area(s)
One engine per REGION. Results merge into one ordered token list per page.

Golden rules honoured here: one engine per region; never run all engines together; never
silently deliver — if an engine a page needs is unavailable, the page yields NO tokens and is
flagged (KEEP PIXELS / route to review) rather than guessing; handwriting is never auto-promoted
to a question number here (that is the structure engine's sequence/ownership job).

The heavy OCR backends (paddleocr, transformers+torch) are imported BEHIND guards, exactly like
the CV stack in structure_engine: the router runs today for digital PDFs with no heavy deps, and
lights up PaddleOCR/TrOCR the moment those wheels are installed — no code change.
"""
from .models import OcrToken, PageKind, RegionKind, Region, PageRouting
from .router import route_document, ocr_page
from .document_engine import process_document

__all__ = [
    "OcrToken",
    "PageKind",
    "RegionKind",
    "Region",
    "PageRouting",
    "route_document",   # standalone OCR view (diagnostics / OCR stage in isolation)
    "ocr_page",         # per-page OCR unit
    "process_document",  # THE production entry — full lifecycle, returns the final result
]
