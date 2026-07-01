"""
OCR ROUTER — the orchestrator. PDF bytes → per-page unified tokens, by routing each page (and each
region of a scanned page) to exactly ONE engine. This is the single entry the FastAPI /ocr-document
route calls and the first stage of the Python document engine.

    classify_page → DIGITAL : PyMuPDF whole page
                  → MIXED   : PyMuPDF text layer + region OCR of the raster area
                  → SCANNED : render → region split → PRINTED→Paddle, HANDWRITTEN→TrOCR → merge
                  → EMPTY   : no tokens, flagged

Hard rules enforced here: one engine per region; the three engines never all run on a page; if a page
NEEDS an engine that isn't installed, the page is DEGRADED (tokens empty, `degraded=True`, KEEP PIXELS)
and surfaced in the routing audit — never read with the wrong engine and never silently delivered.
Output tokens are ordered top-to-bottom / left-to-right and shaped exactly as the structure engine's
`words`, so the existing analyze/build pipeline consumes them unchanged.
"""
from __future__ import annotations

import logging
from typing import List

from .digital_extractor import extract_digital
from .models import EngineUnavailable, OcrToken, PageKind, PageRouting, RegionKind
from .page_router import classify_page
from .paddle_adapter import extract_printed, paddle_available
from .rapid_adapter import extract_printed as extract_printed_rapid, rapid_available
from .region_classifier import detect_regions
from .trocr_adapter import extract_handwritten, trocr_available

log = logging.getLogger("ocr-cleanup")

# Render DPI for raster OCR. 200 balances recognition quality against memory/time on big scans.
RENDER_DPI = int(__import__("os").environ.get("OCR_RENDER_DPI", "200"))


def _render(page) -> "object":
    """Render a page to a numpy image at RENDER_DPI. Returns (image, scale) where scale = PDF points
    per pixel (72/DPI). Requires numpy (present in this sidecar)."""
    import numpy as np

    pix = page.get_pixmap(dpi=RENDER_DPI, alpha=False)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    if pix.n >= 3:
        img = img[:, :, :3]
    else:
        img = img[:, :, 0]
    scale = 72.0 / float(RENDER_DPI)
    return img, scale


def _order(tokens: List[OcrToken]) -> List[OcrToken]:
    """Natural reading order: top-to-bottom, then left-to-right within a ~line band."""
    return sorted(tokens, key=lambda t: (round(t.y0 / 6.0), t.x0))


def _ocr_regions(image, index: int, scale: float, routing: PageRouting) -> List[OcrToken]:
    """Run the per-region engines on a rendered surface: printed→Paddle, handwritten→TrOCR. One engine
    per region. A missing engine for regions that need it degrades the page (KEEP PIXELS), recorded in
    `routing`; it never falls back to the other engine."""
    regions = detect_regions(image, scale)
    printed = [r for r in regions if r.kind == RegionKind.PRINTED]
    handwritten = [r for r in regions if r.kind == RegionKind.HANDWRITTEN]
    routing.region_count = len(regions)
    routing.printed_regions = len(printed)
    routing.handwritten_regions = len(handwritten)

    tokens: List[OcrToken] = []
    if printed:
        # PRINTED: PaddleOCR (primary) → RapidOCR (graceful fallback when Paddle can't be installed) →
        # degrade. Never block the document on a package install; never read with the WRONG kind of engine.
        try:
            tokens += extract_printed(image, index, scale, printed)
            routing.engines.append("paddle")
        except EngineUnavailable:
            try:
                tokens += extract_printed_rapid(image, index, scale, printed)
                routing.engines.append("rapidocr")
            except EngineUnavailable:
                routing.unavailable.append("paddle/rapidocr")
                routing.degraded = True
    if handwritten:
        # HANDWRITTEN: TrOCR (primary) → RapidOCR (fallback reads handwriting as best-effort) → degrade.
        try:
            tokens += extract_handwritten(image, index, scale, handwritten)
            routing.engines.append("trocr")
        except EngineUnavailable:
            try:
                tokens += extract_printed_rapid(image, index, scale, handwritten)
                routing.engines.append("rapidocr")
            except EngineUnavailable:
                routing.unavailable.append("trocr/rapidocr")
                routing.degraded = True
    return tokens


def ocr_page(page, index: int) -> "tuple[List[OcrToken], PageRouting]":
    """OCR ONE page: classify → route → ordered tokens + a routing audit. The single per-page unit the
    whole engine reuses (both the standalone OCR router and the integrated Document Engine). Never raises
    for a bad page — it degrades (KEEP PIXELS) and records why."""
    rect = page.rect
    kind = classify_page(page)
    r = PageRouting(index=index, kind=kind, width=float(rect.width), height=float(rect.height))
    tokens: List[OcrToken] = []

    if kind == PageKind.DIGITAL:
        tokens = extract_digital(page, index)
        r.engines.append("pymupdf")
    elif kind == PageKind.MIXED:
        # Text layer via PyMuPDF; raster area via the region engines (printed/handwritten).
        tokens = extract_digital(page, index)
        r.engines.append("pymupdf")
        try:
            image, scale = _render(page)
            tokens += _ocr_regions(image, index, scale, r)
        except EngineUnavailable as e:
            r.unavailable.append(e.engine)
            r.degraded = True
        except Exception as e:  # noqa: BLE001 — render/CV hiccup: keep the digital tokens
            r.note = f"region OCR skipped: {e}"
    elif kind == PageKind.SCANNED:
        try:
            image, scale = _render(page)
            tokens = _ocr_regions(image, index, scale, r)
            if r.degraded and not tokens:
                r.note = "scanned page needs an OCR engine that is not installed — KEEP PIXELS"
        except Exception as e:  # noqa: BLE001
            r.degraded = True
            r.note = f"scanned render failed: {e}"
    else:  # EMPTY
        r.degraded = True
        r.note = "no text layer and no raster — nothing to OCR"

    tokens = _order(tokens)
    r.token_count = len(tokens)
    return tokens, r


def route_document(pdf_bytes: bytes, document_id: str) -> dict:
    """Route an entire PDF (standalone OCR view — diagnostics + the OCR stage in isolation). Returns
    { documentId, pages:[{index,width,height,words}], routing:[...], engineStatus:{paddle,trocr} }.
    The PRODUCTION entry is the integrated Document Engine (document_engine.process_document), which
    reuses ocr_page and continues straight into ownership → crops → N=N=C → deliver."""
    import fitz

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pages_out: List[dict] = []
    routing_out: List[dict] = []
    try:
        for index in range(doc.page_count):
            tokens, r = ocr_page(doc.load_page(index), index)
            pages_out.append(
                {
                    "index": index,
                    "width": round(r.width, 2),
                    "height": round(r.height, 2),
                    "words": [t.to_word() for t in tokens],
                }
            )
            routing_out.append(r.to_dict())
    finally:
        doc.close()

    return {
        "documentId": document_id,
        "pages": pages_out,
        "routing": routing_out,
        "engineStatus": {"paddle": paddle_available(), "trocr": trocr_available(), "rapidocr": rapid_available()},
    }
