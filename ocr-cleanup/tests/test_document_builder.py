"""End-to-end document build tests (needs Pillow/numpy — CV venv).

Builds a synthetic doc (words + matching page renders) and verifies Python runs the full
path — Visual Intelligence → crop build → repair → validate → Stage 1+2 N=N=C → crop bytes
— and only sets `deliver` when every gate passes.
"""
import base64
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.structure_engine.document_builder import build_document  # noqa: E402
from app.structure_engine import crop_engine as ce  # noqa: E402


def _assert(c, m):
    if not c:
        raise AssertionError(m)


def W(text, x0, y, w=None):
    return {"text": text, "x0": x0, "y0": y, "x1": x0 + (w if w else len(text) * 8), "y1": y + 16}


def _stem(n, y):
    return [W(f"{n}.", 60, y), W("What", 84, y), W("is", 130, y), W("shown", 150, y)]


def _opts(y):
    o = []
    for i, l in enumerate(("A)", "B)", "C)", "D)")):
        yy = y + 24 * (i + 1)
        o += [W(l, 60, yy), W("ans", 84, yy)]
    return o


def _render(width, height, words):
    """A page render that matches the word boxes (black text boxes on white)."""
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (width, height), "white")
    d = ImageDraw.Draw(img)
    for w in words:
        d.rectangle([w["x0"], w["y0"], w["x1"], w["y1"]], fill="black")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _doc(with_images=True):
    pages = []
    words = []
    for i, base in enumerate((40, 240, 440), 1):
        words += _stem(i, base) + _opts(base)
    page = {"index": 1, "width": 650, "height": 900, "words": words}
    if with_images:
        page["imageBase64"] = _render(650, 900, words)
    return {"documentId": "BUILD", "pages": [page]}


def test_build_end_to_end():
    if not ce.CROP_AVAILABLE or not ce._NP:
        print("  skip (no Pillow/numpy)")
        return
    r = build_document(_doc(with_images=True))
    _assert(r["cropGate"] == "PASS", f"cropGate {r['cropGate']}")
    _assert(len(r["crops"]) == 3, f"3 crops built, got {len(r['crops'])}")
    for c in r["crops"]:
        _assert(c["pngBase64"], f"crop {c['number']} has bytes")
        _assert(c["valid"], f"crop {c['number']} valid (no edge cut): {c['edges']}")
    b = r["build"]
    _assert(b["cropCount"] == 3, f"cropCount {b['cropCount']}")
    _assert(b["stage2"]["status"] == "PASS", f"stage2 {b['stage2']}")
    _assert(r["deliver"] is True, "deliver true when all gates pass")
    print("  ok test_build_end_to_end")


def test_build_no_render_no_deliver():
    r = build_document(_doc(with_images=False))
    _assert(r["crops"] == [], "no renders → no crops")
    _assert(r["deliver"] is False, "no deliver without renders")
    _assert(r["build"]["stage2"]["status"] == "PENDING_WIRING", "stage2 pending without renders")
    print("  ok test_build_no_render_no_deliver")


def test_build_delivers_partial_options():
    if not ce.CROP_AVAILABLE:
        print("  skip (no Pillow)")
        return
    # 4-option-dominant paper (3 full questions) + one question with only 2 options.
    # Partial options → cropGate PASS (missing labels advisory; pre_delivery_validator gates).
    words = []
    for i, base in enumerate((40, 240, 440), 1):
        words += _stem(i, base) + _opts(base)
    words += _stem(4, 640) + [W("A)", 60, 664), W("x", 84, 664), W("B)", 60, 688), W("y", 84, 688)]
    page = {"index": 1, "width": 650, "height": 760, "words": words, "imageBase64": _render(650, 760, words)}
    r = build_document({"documentId": "INC", "pages": [page]})
    _assert(r["cropGate"] == "PASS", f"partial options → PASS, got {r['cropGate']}")
    _assert(r["deliver"] is True, "partial options do not block delivery")
    print("  ok test_build_delivers_partial_options")


ALL = [test_build_end_to_end, test_build_no_render_no_deliver, test_build_delivers_partial_options]


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
