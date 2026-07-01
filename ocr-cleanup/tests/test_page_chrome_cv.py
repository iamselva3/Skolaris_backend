"""Repeated header/footer/divider removal — universal, no document-specific values.

Synthetic pages with a header bar IDENTICAL on every page (logo stand-in) + unique content below.
The cleaner must whiten the repeated band, preserve the unique content, and NO-OP on clean docs and
on too-few-pages (KEEP PIXELS).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from app.structure_engine import page_chrome_cv as cc  # noqa: E402

H, W = 300, 200


def _page(content_row: int) -> Image.Image:
    a = np.full((H, W, 3), 255, dtype=np.uint8)
    a[5:25, 20:180, :] = 0          # repeated HEADER bar (identical on every page)
    a[content_row:content_row + 12, 30:170, :] = 0  # UNIQUE content (varies per page)
    return Image.fromarray(a, "RGB")


def test_repeated_header_whitened_content_kept():
    renders = {i: _page(120 + i * 15) for i in range(5)}  # 5 pages, header identical, content varies
    cleaned, rep = cc.detect_and_clean(renders)
    assert rep["skipped"] is None, rep
    assert rep["headerFrac"] > 0
    top = np.asarray(cleaned[0])[0:30]
    assert top.mean() > 250, "header band must be whitened"
    # the unique content of page 0 (rows ~120) must survive
    body = np.asarray(cleaned[0])[120:132]
    assert body.min() < 50, "unique content must be preserved"


def test_too_few_pages_noop():
    renders = {i: _page(120 + i * 15) for i in range(2)}  # < 3 pages ⇒ no cross-page evidence
    cleaned, rep = cc.detect_and_clean(renders)
    assert rep["skipped"] is not None
    assert np.asarray(cleaned[0])[5:25].min() == 0, "header must be untouched with too few pages"


def test_clean_document_noop():
    # no repeated band — every page is just unique content
    renders = {i: _page(40 + i * 30) for i in range(5)}
    for i in renders:  # remove the shared header bar so nothing repeats
        a = np.asarray(renders[i]).copy()
        a[5:25, 20:180, :] = 255
        renders[i] = Image.fromarray(a, "RGB")
    cleaned, rep = cc.detect_and_clean(renders)
    assert rep["headerFrac"] == 0.0 and rep["footerFrac"] == 0.0


if __name__ == "__main__":
    g = dict(globals())
    ok = fail = 0
    for n, fn in g.items():
        if n.startswith("test_") and callable(fn):
            try:
                fn(); print("ok", n); ok += 1
            except Exception as e:  # noqa: BLE001
                print("FAIL", n, repr(e)); fail += 1
    print(f"--- {ok} passed, {fail} failed ---")
    raise SystemExit(1 if fail else 0)
