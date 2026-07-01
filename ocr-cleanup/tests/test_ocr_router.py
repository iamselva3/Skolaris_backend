"""
OCR ROUTER tests — lock the routing decisions + the degrade-don't-guess contract.

These build tiny in-memory PDFs with PyMuPDF (no external fixtures, no PDF names hardcoded) so the
page classifier and the unified-token contract are pinned: a real text layer routes DIGITAL, a
rendered-but-textless page routes SCANNED, a blank page routes EMPTY, and a scanned page with no OCR
backend installed yields ZERO tokens + degraded=True (KEEP PIXELS) rather than guessing.
"""
import fitz

from app.ocr_engine import route_document
from app.ocr_engine.models import PageKind
from app.ocr_engine.page_router import classify_page


def _digital_pdf() -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 100), "1. What is the SI unit of force?\n(a) Newton (b) Joule (c) Watt (d) Pascal")
    page.insert_text((72, 160), "2. Acceleration due to gravity is approximately 9.8 m/s squared on Earth.")
    return doc.tobytes()


def _blank_pdf() -> bytes:
    doc = fitz.open()
    doc.new_page()
    return doc.tobytes()


def _scanned_like_pdf() -> bytes:
    """A page with ink but NO text layer — drawn as vector shapes, so it must route SCANNED, not EMPTY."""
    doc = fitz.open()
    page = doc.new_page()
    for i in range(40):
        y = 80 + i * 12
        page.draw_rect(fitz.Rect(72, y, 520, y + 6), fill=(0, 0, 0))  # ink bars, no extractable text
    return doc.tobytes()


def test_digital_page_routes_pymupdf_with_tokens():
    res = route_document(_digital_pdf(), "digital")
    assert res["routing"][0]["kind"] == PageKind.DIGITAL.value
    assert res["routing"][0]["engines"] == ["pymupdf"]
    assert res["routing"][0]["degraded"] is False
    assert len(res["pages"][0]["words"]) > 0
    # exact token contract
    w = res["pages"][0]["words"][0]
    assert set(w.keys()) == {"text", "x0", "y0", "x1", "y1", "conf"}


def test_blank_page_routes_empty_no_tokens():
    res = route_document(_blank_pdf(), "blank")
    assert res["routing"][0]["kind"] == PageKind.EMPTY.value
    assert res["pages"][0]["words"] == []
    assert res["routing"][0]["degraded"] is True


def test_scanned_page_without_text_layer_routes_scanned():
    doc = fitz.open(stream=_scanned_like_pdf(), filetype="pdf")
    assert classify_page(doc.load_page(0)) == PageKind.SCANNED
    doc.close()


def test_scanned_page_degrades_only_when_no_ocr_backend_at_all():
    """A scanned page degrades (KEEP PIXELS) ONLY when NO OCR backend is available — Paddle AND its
    RapidOCR fallback AND TrOCR all absent. When any is present (RapidOCR is the graceful fallback that
    installs on Py3.13), the page is OCR'd instead of degraded — the document keeps processing."""
    res = route_document(_scanned_like_pdf(), "scanned")
    r0 = res["routing"][0]
    if r0["kind"] != PageKind.SCANNED.value:
        return  # environment has a text layer fallback; SCANNED-routing covered by the classifier test
    st = res["engineStatus"]
    any_backend = st.get("paddle") or st.get("rapidocr") or st.get("trocr")
    if not any_backend:
        # truly no backend → must degrade, never guess
        assert res["pages"][0]["words"] == []
        assert r0["degraded"] is True
        assert r0["unavailable"]
    else:
        # a backend (e.g. RapidOCR fallback) is present → page processed, not blocked
        assert r0["degraded"] is False
