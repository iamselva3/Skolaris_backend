"""Coordinate-space alignment validation tests — universal, no document-specific values.

Proves the gate that stops the "counts pass but every crop is a top-left fragment" failure:
points-vs-pixels mixing is caught BEFORE any crop is cut, and a clean uniform-DPI render passes.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.structure_engine import coordinate_validator as cv  # noqa: E402


def _pages(*dims):
    return [{"index": i, "width": w, "height": h} for i, (w, h) in enumerate(dims)]


def test_aligned_uniform_dpi_passes():
    # one 200-DPI render of an A4-ish page: scaleX≈scaleY≈2.78, ownership inside the render.
    pages = _pages((595.0, 842.0))
    render = {0: (1653.0, 2339.0)}
    ext = {0: (560.0, 800.0)}  # owned content well inside the page
    r = cv.validate(pages, render, ext)
    assert r["aligned"] is True, r["reasons"]
    assert abs(r["scaleByPage"][0] - 2.78) < 0.05
    assert r["documentScale"] is not None


def test_points_vs_pixels_mix_fails():
    # THE bug: page 2 is in point space (scale 1.0) while page 1 is 200-DPI (2.78). Mixed coordinate
    # spaces in one document — both own content → must be flagged, not silently delivered.
    pages = _pages((595.0, 842.0), (595.0, 842.0))
    render = {0: (1653.0, 2339.0), 1: (595.0, 842.0)}
    ext = {0: (560.0, 800.0), 1: (560.0, 800.0)}
    r = cv.validate(pages, render, ext)
    assert r["aligned"] is False
    assert any("scale_outlier" in x for x in r["reasons"])


def test_aspect_mismatch_fails():
    # render squashed on one axis (scaleX≠scaleY) ⇒ aspect not preserved ⇒ spaces are mixed.
    pages = _pages((595.0, 842.0))
    render = {0: (1653.0, 1000.0)}
    ext = {0: (560.0, 800.0)}
    r = cv.validate(pages, render, ext)
    assert r["aligned"] is False
    assert any("aspect_mismatch" in x for x in r["reasons"])


def test_ownership_outside_render_fails():
    # ownership extent (point space) scales to BEYOND the render bounds ⇒ regions are off-page ⇒
    # the ownership boxes are not in the render's space.
    pages = _pages((595.0, 842.0))
    render = {0: (1653.0, 2339.0)}
    ext = {0: (900.0, 800.0)}  # 900 * 2.78 ≈ 2502 > 1653 render width
    r = cv.validate(pages, render, ext)
    assert r["aligned"] is False
    assert any("ownership_outside_render" in x for x in r["reasons"])


def test_missing_render_for_content_page_fails():
    pages = _pages((595.0, 842.0))
    render = {}  # no render at all
    ext = {0: (560.0, 800.0)}
    r = cv.validate(pages, render, ext)
    assert r["aligned"] is False
    assert any("render_missing" in x for x in r["reasons"])


def test_page_without_content_is_ignored():
    # a cover/blank page with no owned content and no render must not fail the whole document.
    pages = _pages((595.0, 842.0), (595.0, 842.0))
    render = {0: (1653.0, 2339.0)}  # page 1 has no render but also no content
    ext = {0: (560.0, 800.0)}       # only page 0 owns content
    r = cv.validate(pages, render, ext)
    assert r["aligned"] is True, r["reasons"]


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
