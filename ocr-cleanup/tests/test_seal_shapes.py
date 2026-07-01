"""Seal SHAPE recall layer — finds solid seal badges, ignores text + figures; no-op on plain pages."""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image, ImageDraw  # noqa: E402

from app.structure_engine import seal_shapes as ss  # noqa: E402

W, H = 1000, 1300


def _page_with_seal():
    im = Image.new("RGB", (W, H), "white"); d = ImageDraw.Draw(im)
    d.ellipse((40, 300, 95, 355), fill="black")        # a dark seal (~0.04*W) …
    d.rectangle((56, 315, 80, 340), fill="white")      # … with a reversed-out NUMBER (the bright core)
    d.text((120, 312), "Consider the following statements about the topic", fill="black")
    d.text((42, 120), "5.", fill="black")              # plain number (thin) — NOT a seal
    d.rectangle((300, 600, 700, 1000), fill="black")    # a large SOLID figure — NOT a seal (no light core)
    return im


def test_detects_solid_seal_only():
    boxes = ss.detect_seal_shapes(_page_with_seal())
    assert len(boxes) == 1, f"only the seal, not text/figure: {boxes}"
    x0, y0, x1, y1 = boxes[0]
    assert 30 <= x0 <= 110 and 280 <= y0 <= 370


def test_plain_page_is_noop():
    im = Image.new("RGB", (W, H), "white"); d = ImageDraw.Draw(im)
    for k in range(6):
        d.text((42, 100 + k * 60), f"{k + 1}.", fill="black")
        d.text((120, 100 + k * 60), "A plain numbered thin-stroke question", fill="black")
    assert ss.detect_seal_shapes(im) == []


def test_real_document_smoke():
    pdf = os.environ.get("BADGE_PDF", "C:/Users/hp/Downloads/AD 2601 Q.pdf")
    if not ss.available() or not os.path.exists(pdf):
        print("skip real-doc smoke (cv2 or PDF absent)"); return
    import fitz
    doc = fitz.open(pdf); pages = doc.page_count
    total = 0
    for pi in range(pages):
        pix = doc.load_page(pi).get_pixmap(dpi=200, alpha=False)
        im = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
        total += len(ss.detect_seal_shapes(im))
    doc.close()
    assert total >= 25, f"expected the seal badges to be found, got {total}"
    print(f"real-doc smoke: {total} seals across {pages} pages")


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
