"""Crop VISIBILITY = CONTENT-ONLY tests (needs Pillow/numpy — CV venv).

Proves the new rule: the question NUMBER is an INTERNAL anchor only — it is ERASED from the delivered
crop (the UI owns numbering), the crop keeps its content (stem/options/visuals), and a crop that STILL
shows numbering FAILS validation (never silently delivered).
"""
import base64
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.structure_engine import crop_engine as ce  # noqa: E402
from app.structure_engine import crop_visibility as cv  # noqa: E402
from app.structure_engine.document_builder import build_document  # noqa: E402


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


# ── unit: number_present / validate_crop (content-only) ───────────────────────────────────────────
def test_number_present_true():
    if not cv._NP:
        print("  skip (no numpy)")
        return
    crop = _page(300, 120, [(4, 4, 40, 30)])  # ink in the number box
    _assert(cv.number_present(crop, (4, 4, 40, 30)), "inked number box → present (would FAIL content-only)")
    print("  ok test_number_present_true")


def test_number_present_false_when_blank():
    if not cv._NP:
        print("  skip (no numpy)")
        return
    crop = _page(300, 120, [(150, 60, 260, 90)])  # ink only on the stem, number band blank
    _assert(not cv.number_present(crop, (4, 4, 40, 30)), "blank number band → absent (content-only)")
    print("  ok test_number_present_false_when_blank")


def test_validate_crop_fails_when_number_shown():
    if not cv._NP:
        print("  skip (no numpy)")
        return
    crop = _page(300, 160, [(4, 4, 40, 30), (60, 60, 260, 140)])  # number + stem both present
    v = cv.validate_crop(crop, (4, 4, 40, 30), option_count=4, expected_options=4)
    _assert(not v["numberRemoved"], "number still shown")
    _assert(not v["ok"], "numbering in crop ⇒ NOT ok (content-only gate)")
    _assert("question_number_still_in_crop" in v["failures"], f"failure recorded: {v['failures']}")
    print("  ok test_validate_crop_fails_when_number_shown")


def test_validate_crop_ok_when_content_only():
    if not cv._NP:
        print("  skip (no numpy)")
        return
    crop = _page(300, 160, [(60, 60, 260, 140)])  # stem only, number already removed
    v = cv.validate_crop(crop, (4, 4, 40, 30), option_count=4, expected_options=4)
    _assert(v["numberRemoved"] and v["ok"], f"content-only crop ⇒ ok, got {v}")
    print("  ok test_validate_crop_ok_when_content_only")


# ── repair-level: number is ERASED, content kept ─────────────────────────────────────────────────
def test_repair_erases_number_keeps_content():
    if not ce.CROP_AVAILABLE or not ce._NP:
        print("  skip (no Pillow/numpy)")
        return
    # number glyph at x≈20 (left margin) on the same row as the stem to its right.
    p = _page(650, 200, [(20, 40, 45, 70), (90, 40, 400, 70)])
    region = [(1, 18, 38, 410, 80)]
    number_box = (1, 20, 40, 45, 70)
    png_rm, regs, edges = ce.repair_crop(region, {1: p}, step=40, max_iters=4,
                                         number_box=number_box, remove_number=True)
    png_keep, _, _ = ce.repair_crop(region, {1: p}, step=40, max_iters=4,
                                    number_box=number_box, remove_number=False)
    _assert(png_rm is not None and png_keep is not None, "crops built")
    _assert(not edges.get("number"), f"number removed, no leftover-number flag: {edges}")
    _assert(_black_px(png_rm) > 0, "content (stem) preserved after number removal")
    _assert(_black_px(png_rm) < _black_px(png_keep),
            f"removed-number crop has fewer ink px ({_black_px(png_rm)}) than kept ({_black_px(png_keep)})")
    print("  ok test_repair_erases_number_keeps_content")


def test_repair_no_number_box_is_noop():
    if not ce.CROP_AVAILABLE or not ce._NP:
        print("  skip (no Pillow/numpy)")
        return
    p = _page(650, 200, [(60, 40, 400, 70)])
    png, regs, edges = ce.repair_crop([(1, 50, 30, 410, 80)], {1: p}, step=40)  # no number_box
    _assert(png is not None and "number" not in edges, "no number box ⇒ no number handling (noop)")
    print("  ok test_repair_no_number_box_is_noop")


# ── end-to-end: build_document delivers content-only crops ────────────────────────────────────────
def _render(width, height, words):
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (width, height), "white")
    d = ImageDraw.Draw(img)
    for w in words:
        d.rectangle([w["x0"], w["y0"], w["x1"], w["y1"]], fill="black")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _W(text, x0, y, w=None):
    return {"text": text, "x0": x0, "y0": y, "x1": x0 + (w if w else len(text) * 8), "y1": y + 16}


def test_build_document_content_only_end_to_end():
    if not ce.CROP_AVAILABLE or not ce._NP:
        print("  skip (no Pillow/numpy)")
        return
    words = []
    for i, base in enumerate((40, 240, 440), 1):
        words += [_W(f"{i}.", 60, base), _W("What", 90, base), _W("is", 136, base), _W("shown", 156, base)]
        for k, l in enumerate(("A)", "B)", "C)", "D)")):
            yy = base + 24 * (k + 1)
            words += [_W(l, 60, yy), _W("ans", 84, yy)]
    page = {"index": 1, "width": 650, "height": 900, "words": words, "imageBase64": _render(650, 900, words)}
    r = build_document({"documentId": "CONTENTONLY", "pages": [page]})
    _assert(len(r["crops"]) == 3, f"3 crops, got {len(r['crops'])}")
    for c in r["crops"]:
        vis = c.get("visibility") or {}
        _assert(vis.get("numberRemoved"), f"q{c['number']} number removed from crop")
        _assert(vis.get("numberAnchorInternalOnly"), f"q{c['number']} number is internal anchor only")
        _assert(not c["edges"].get("number"), f"q{c['number']} no leftover-number flag: {c['edges']}")
        _assert(c["valid"] and c["pngBase64"], f"q{c['number']} valid content-only crop")
        _assert(_black_px(base64.b64decode(c["pngBase64"])) > 0, f"q{c['number']} keeps content")
    # numbering stays an internal anchor — counts/ownership intact
    _assert(r["questionCount"]["logicalQuestionCount"] == 3, "internal numbering count intact")
    _assert(r["deliver"] is True, "delivers content-only crops when all gates pass")
    print("  ok test_build_document_content_only_end_to_end")


ALL = [
    test_number_present_true,
    test_number_present_false_when_blank,
    test_validate_crop_fails_when_number_shown,
    test_validate_crop_ok_when_content_only,
    test_repair_erases_number_keeps_content,
    test_repair_no_number_box_is_noop,
    test_build_document_content_only_end_to_end,
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
