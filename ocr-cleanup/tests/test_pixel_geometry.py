"""Regression tests for the PIXEL-based geometry refinements (chrome_pixels + column_pixels).

These guard the universal fixes for the two real-document failures they were built for:
  • an IMAGE header/footer (logo / banner / scan border) the token detector is blind to;
  • a 2-column scanned page whose sparse OCR collapsed the token column detector to ONE column.

Synthetic renders only (numpy + PIL) — no PDF, no real capture; every threshold is exercised by
construction so the behaviour is pinned without depending on a specific institute's pixels.
"""
from __future__ import annotations

import base64
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np  # type: ignore
from PIL import Image  # type: ignore

from app.structure_engine import chrome_pixels, column_pixels
from app.structure_engine.geometry import Column
from app.structure_engine.models import PageInput


def _page(index, arr):
    """Wrap a HxWx3 uint8 numpy render as a PageInput carrying its base64 PNG (width/height = pixels)."""
    img = Image.fromarray(arr, "RGB")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return PageInput(index=index, width=float(arr.shape[1]), height=float(arr.shape[0]),
                     words=[], markers=[], image_base64=b64)


def _assert(cond, msg):
    if not cond:
        raise AssertionError(msg)


# ── chrome_pixels ────────────────────────────────────────────────────────────────────────────────
def test_pixel_chrome_detects_repeated_header_footer():
    """A black header band (rows 0-30) + footer band (rows 270-300) repeated on every page, with DIFFERENT
    body ink per page, must be returned as a chrome band; the varying body must NOT be."""
    H, W = 300, 200
    pages = []
    for i in range(4):
        a = np.full((H, W, 3), 255, np.uint8)
        a[0:30, :, :] = 0          # repeated header (logo band)
        a[275:300, :, :] = 0       # repeated footer
        a[80 + i * 30:100 + i * 30, 40:160, :] = 0  # body content moves per page (NOT chrome)
        pages.append(_page(i + 1, a))
    bands = chrome_pixels.pixel_chrome_bands(pages)
    _assert(len(bands) == 4, f"all 4 pages get a band, got {len(bands)}")
    hb, ft = bands[1]
    _assert(20 <= hb <= 60, f"header_bottom near 30, got {hb}")
    _assert(255 <= ft <= 285, f"footer_top near 275, got {ft}")
    print("  ok test_pixel_chrome_detects_repeated_header_footer")


def test_pixel_chrome_clean_document_no_band():
    """Pages with ONLY varying body ink and no repeated edge band ⇒ no chrome (KEEP PIXELS)."""
    H, W = 300, 200
    pages = []
    for i in range(4):
        a = np.full((H, W, 3), 255, np.uint8)
        a[40 + i * 40:70 + i * 40, 30:170, :] = 0  # different each page, mid-body
        pages.append(_page(i + 1, a))
    bands = chrome_pixels.pixel_chrome_bands(pages)
    for pi, (hb, ft) in bands.items():
        _assert(hb <= 1.0, f"no header on clean page {pi}, got {hb}")
        _assert(ft >= H - 1.0, f"no footer on clean page {pi}, got {ft}")
    print("  ok test_pixel_chrome_clean_document_no_band")


def test_pixel_chrome_skips_short_doc():
    """< 3 same-size pages ⇒ no cross-page evidence ⇒ no band."""
    H, W = 300, 200
    pages = [_page(1, np.zeros((H, W, 3), np.uint8)), _page(2, np.zeros((H, W, 3), np.uint8))]
    _assert(chrome_pixels.pixel_chrome_bands(pages) == {}, "2-page doc yields no bands")
    print("  ok test_pixel_chrome_skips_short_doc")


# ── column_pixels ────────────────────────────────────────────────────────────────────────────────
def test_pixel_columns_recovers_two_columns():
    """A 2-column page (ink in two bands, a central blank gutter) whose TOKEN detector collapsed it to one
    column must be split back into two by the pixels."""
    H, W = 400, 400
    a = np.full((H, W, 3), 255, np.uint8)
    # left column ink x[40,180], right column ink x[220,360], gutter x[180,220] blank; many body rows
    for y in range(40, 360, 12):
        a[y:y + 6, 40:180, :] = 0
        a[y:y + 6, 220:360, :] = 0
    page = _page(1, a)
    token_cols = [Column(left=0.0, right=float(W))]  # the failure: tokens saw ONE column
    refined = column_pixels.refine_columns(page, token_cols)
    _assert(len(refined) == 2, f"pixels recover 2 columns, got {len(refined)}")
    _assert(refined[0].right < 220 and refined[1].left > 180, f"gutter near centre: {refined}")
    print("  ok test_pixel_columns_recovers_two_columns")


def test_pixel_columns_single_column_unchanged():
    """A genuine single-column page (ink across the centre) must stay one column — a wide right margin is
    not a gutter."""
    H, W = 400, 400
    a = np.full((H, W, 3), 255, np.uint8)
    for y in range(40, 360, 12):
        a[y:y + 6, 40:360, :] = 0  # full-width text, no central gutter
    page = _page(1, a)
    token_cols = [Column(left=0.0, right=float(W))]
    refined = column_pixels.refine_columns(page, token_cols)
    _assert(len(refined) == 1, f"single column stays 1, got {len(refined)}")
    print("  ok test_pixel_columns_single_column_unchanged")


def test_pixel_columns_trusts_multicolumn_tokens():
    """When the tokens already found ≥2 columns, the pixel pass does not touch them (a wide in-column
    paragraph gap must never manufacture a 3rd column)."""
    H, W = 400, 400
    a = np.full((H, W, 3), 255, np.uint8)
    for y in range(40, 360, 12):
        a[y:y + 6, 40:360, :] = 0
    page = _page(1, a)
    token_cols = [Column(left=0.0, right=190.0), Column(left=210.0, right=400.0)]
    refined = column_pixels.refine_columns(page, token_cols)
    _assert(len(refined) == 2, f"token 2-column kept, got {len(refined)}")
    print("  ok test_pixel_columns_trusts_multicolumn_tokens")


# ── grid-table (answer-key) page detection ───────────────────────────────────────────────────────
def test_grid_page_detected_and_excluded():
    """A full-page MULTI-COLUMN TABLE (many horizontal rows + several vertical columns) — an answer-key /
    error-analysis / OMR sheet — must be flagged so its numbered rows never become questions."""
    from app.structure_engine.pipeline import _detect_grid_pages

    H, W = 600, 440
    a = np.full((H, W, 3), 255, np.uint8)
    for y in range(80, 560, 24):       # ~20 horizontal rules (table rows)
        a[y:y + 2, 30:410, :] = 0
    for x in range(30, 411, 55):       # ~8 vertical rules (table columns)
        a[80:558, x:x + 2, :] = 0
    grids = _detect_grid_pages([_page(1, a)])
    _assert(1 in grids, f"full-page multi-column grid must be detected, got {grids}")
    print("  ok test_grid_page_detected_and_excluded")


def test_question_page_not_a_grid():
    """A normal question page (text blocks, at most a box or two) must NOT be flagged as a grid."""
    from app.structure_engine.pipeline import _detect_grid_pages

    H, W = 600, 440
    a = np.full((H, W, 3), 255, np.uint8)
    for i, y in enumerate(range(60, 540, 16)):  # sparse text glyphs: short marks, offset per row, low
        off = 40 + (i * 7) % 25                  # coverage per row + no vertical alignment ⇒ no rules
        for x in range(off, 360, 34):
            a[y:y + 5, x:x + 8, :] = 0
    grids = _detect_grid_pages([_page(1, a)])
    _assert(1 not in grids, f"a text question page must not be a grid, got {grids}")
    print("  ok test_question_page_not_a_grid")


TESTS = [
    test_pixel_chrome_detects_repeated_header_footer,
    test_pixel_chrome_clean_document_no_band,
    test_pixel_chrome_skips_short_doc,
    test_pixel_columns_recovers_two_columns,
    test_pixel_columns_single_column_unchanged,
    test_pixel_columns_trusts_multicolumn_tokens,
    test_grid_page_detected_and_excluded,
    test_question_page_not_a_grid,
]

if __name__ == "__main__":
    for t in TESTS:
        t()
    print("pixel-geometry: all passed")
