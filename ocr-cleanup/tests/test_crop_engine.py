"""Crop construction engine tests (needs Pillow — runs in the CV venv).

Builds synthetic page images (white with black content boxes) and verifies Python
constructs a single aligned crop from a question's ownership regions: same-page union,
cross-column → two regions stitched, cross-page → stitched across pages, whitespace
trimmed, content preserved.
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.structure_engine import crop_engine as ce  # noqa: E402


def _assert(c, m):
    if not c:
        raise AssertionError(m)


def _page(w, h, boxes):
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(img)
    for (x0, y0, x1, y1) in boxes:
        d.rectangle([x0, y0, x1, y1], fill="black")
    return img


def _black_px(png_bytes):
    from PIL import Image
    g = Image.open(io.BytesIO(png_bytes)).convert("L")
    return sum(1 for p in g.getdata() if p < 128)


def test_regions_single_column():
    q = {"boxes": [{"page": 1, "x0": 60, "y0": 40, "x1": 300, "y1": 80}],
         "options": [{"page": 1, "x0": 70, "y0": 90, "x1": 320, "y1": 200}]}
    regions = ce.regions_for_question(q)
    _assert(len(regions) == 1, f"single-column → 1 region, got {len(regions)}")
    _, x0, y0, x1, y1 = regions[0]
    _assert(y0 == 40 and y1 == 200, f"region union y {y0}-{y1}")
    print("  ok test_regions_single_column")


def test_regions_cross_column():
    # left column (x~60) + right column (x~360) on the same page → two regions
    q = {"boxes": [{"page": 1, "x0": 60, "y0": 40, "x1": 300, "y1": 250}],
         "options": [{"page": 1, "x0": 360, "y0": 40, "x1": 600, "y1": 160}]}
    regions = ce.regions_for_question(q)
    _assert(len(regions) == 2, f"cross-column → 2 regions, got {len(regions)}")
    _assert(regions[0][1] < regions[1][1], "left region first (reading order)")
    print("  ok test_regions_cross_column")


def test_build_crop_cross_page():
    if not ce.CROP_AVAILABLE:
        print("  skip test_build_crop_cross_page (no Pillow)")
        return
    p1 = _page(650, 900, [(60, 700, 400, 760)])   # question stem near bottom of page 1
    p2 = _page(650, 900, [(60, 40, 400, 160)])    # options at top of page 2
    regions = [(1, 50, 690, 410, 770), (2, 50, 30, 410, 170)]
    png = ce.build_crop(regions, {1: p1, 2: p2})
    _assert(png is not None and len(png) > 0, "crop built")
    _assert(_black_px(png) > 0, "crop preserved content (black pixels present)")
    # stitched height should roughly cover both regions (minus trim), width within page
    from PIL import Image
    out = Image.open(io.BytesIO(png))
    _assert(out.width <= 650 and out.height > 100, f"reasonable crop dims {out.size}")
    print("  ok test_build_crop_cross_page")


def test_build_crop_trims_whitespace():
    if not ce.CROP_AVAILABLE:
        print("  skip test_build_crop_trims_whitespace (no Pillow)")
        return
    # a small content box inside a big page → trim should shrink to ~the content
    p = _page(650, 900, [(100, 100, 200, 140)])
    png = ce.build_crop([(1, 0, 0, 650, 900)], {1: p})
    from PIL import Image
    out = Image.open(io.BytesIO(png))
    _assert(out.width < 300 and out.height < 200, f"trimmed to content {out.size}")
    print("  ok test_build_crop_trims_whitespace")


def test_build_crop_missing_page_safe():
    if not ce.CROP_AVAILABLE:
        print("  skip (no Pillow)")
        return
    png = ce.build_crop([(5, 0, 0, 100, 100)], {1: _page(200, 200, [])})
    _assert(png is None, "missing page render → None (safe, never raises)")
    print("  ok test_build_crop_missing_page_safe")


def test_padding_applied():
    if not ce.CROP_AVAILABLE:
        print("  skip (no Pillow)")
        return
    p = _page(650, 900, [(100, 100, 200, 140)])
    none_pad = ce.build_crop([(1, 0, 0, 650, 900)], {1: p}, pad_frac=0.0)
    with_pad = ce.build_crop([(1, 0, 0, 650, 900)], {1: p}, pad_frac=0.08)
    from PIL import Image
    a = Image.open(io.BytesIO(none_pad))
    b = Image.open(io.BytesIO(with_pad))
    _assert(b.width > a.width and b.height > a.height, "padding adds margin (never hugs content)")
    print("  ok test_padding_applied")


def test_repair_expands_to_resolve_edge_cut():
    if not ce.CROP_AVAILABLE or not ce._NP:
        print("  skip (no Pillow/numpy)")
        return
    # content runs from y=100..400; the initial region cuts it at y=300 (bottom edge cut).
    p = _page(650, 900, [(60, 100, 400, 400)])
    initial = [(1, 50, 90, 410, 300)]   # bottom cuts through the content
    # before repair: bottom edge is cut
    crop0 = ce._assemble([( 1, *initial[0][1:])], {1: p}) if False else None
    png, regs, edges = ce.repair_crop(initial, {1: p}, step=60, max_iters=6, pad_frac=0.0)
    _assert(png is not None, "repaired crop built")
    _assert(not edges.get("bottom"), f"bottom edge cut repaired, edges={edges}")
    _assert(regs[-1][4] > 300, f"region expanded downward: {regs[-1][4]}")
    print("  ok test_repair_expands_to_resolve_edge_cut")


def test_repair_clamps_and_reports_unresolved():
    if not ce.CROP_AVAILABLE or not ce._NP:
        print("  skip (no Pillow/numpy)")
        return
    # content fills the WHOLE page to every edge → repair can't expand past bounds → edges remain
    p = _page(200, 200, [(0, 0, 200, 200)])
    png, regs, edges = ce.repair_crop([(1, 0, 0, 200, 200)], {1: p}, step=20, max_iters=3)
    _assert(png is not None, "still returns a crop")
    _assert(any(edges.values()), "unresolved edges reported (caller routes to review)")
    print("  ok test_repair_clamps_and_reports_unresolved")


ALL = [
    test_regions_single_column,
    test_regions_cross_column,
    test_build_crop_cross_page,
    test_build_crop_trims_whitespace,
    test_build_crop_missing_page_safe,
    test_padding_applied,
    test_repair_expands_to_resolve_edge_cut,
    test_repair_clamps_and_reports_unresolved,
]


def main():
    fails = 0
    for t in ALL:
        try:
            t()
        except Exception as e:  # noqa: BLE001
            fails += 1
            print(f"  FAIL {t.__name__}: {e}")
    print(f"\n{len(ALL) - fails}/{len(ALL)} passed")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
