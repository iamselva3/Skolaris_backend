"""Leading number/badge eraser — content-safe, OCR-independent.

A plain number, a numbered marker, and a CIRCLED BADGE ("143 NM") are erased; stem text that merely
starts with a short word (no number) is preserved. No document-specific values.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from app.structure_engine import leading_marker as lm  # noqa: E402


def _canvas():
    return Image.new("RGB", (620, 170), "white")


def _left_ink(im):
    return float((np.asarray(im.convert("L"))[:, :92] < 200).mean())


def _stem_ink(im):
    return float((np.asarray(im.convert("L"))[:, 120:] < 200).mean())


def _plain():
    im = _canvas(); d = ImageDraw.Draw(im)
    d.text((12, 20), "8.", fill="black")
    d.text((95, 18), "The period of oscillation of a simple", fill="black")
    d.text((95, 44), "pendulum is recorded as 2.63 s", fill="black")
    return im


def _badge():
    im = _canvas(); d = ImageDraw.Draw(im)
    d.ellipse((8, 12, 72, 76), outline="black", width=3)
    d.text((22, 24), "143", fill="black"); d.text((30, 54), "NM", fill="black")
    d.text((100, 18), "Consider the following statements about", fill="black")
    d.text((100, 44), "opioids. They are generally prescribed", fill="black")
    return im


def _nomark():
    im = _canvas(); d = ImageDraw.Draw(im)
    d.text((12, 18), "A capacitor of capacitance 5 uF is", fill="black")
    d.text((12, 44), "connected as shown in the figure", fill="black")
    return im


def _heading():
    im = _canvas(); d = ImageDraw.Draw(im)
    d.text((12, 18), "If a woman is a carrier for haemophilia", fill="black")
    d.text((12, 44), "and marries a normal man, what is", fill="black")
    return im


def test_plain_number_erased():
    im = _plain(); s = _stem_ink(im)
    out, erased, _ = lm.erase(im)
    assert erased and _left_ink(out) < 0.0005, "plain number must be whitened"
    assert abs(_stem_ink(out) - s) < 1e-6, "stem must be preserved"


def test_circled_badge_erased():
    im = _badge(); s = _stem_ink(im)
    out, erased, box = lm.erase(im)
    assert erased and box is not None, "circled badge must be detected"
    assert _left_ink(out) < 0.0005, "badge (circle + digits + NM) must be whitened"
    assert abs(_stem_ink(out) - s) < 1e-6, "stem must be preserved"


def test_stem_starting_with_word_is_safe():
    for im in (_nomark(), _heading()):
        before = _left_ink(im)
        out, erased, _ = lm.erase(im)
        assert not erased, "stem text with no leading number must NOT be erased"
        assert abs(_left_ink(out) - before) < 1e-6


def test_no_marker_present_after_erase():
    out, _, _ = lm.erase(_badge())
    assert lm.present(out) is False, "no leading marker should remain after erase"


# ── GENERALIZATION BATTERY — must hold for ALL papers incl. unseen ones ───────────────
def _q(marker_draw, stem_x, *, badge=False):
    """A question crop: a leading marker + a hanging-indent stem (two wrapped lines)."""
    im = _canvas(); d = ImageDraw.Draw(im)
    marker_draw(d)
    d.text((stem_x, 18), "Consider the following physical", fill="black")
    d.text((stem_x, 44), "situation described above and", fill="black")
    return im


def _content(line1, line2):
    im = _canvas(); d = ImageDraw.Draw(im)
    d.text((12, 18), line1, fill="black")
    d.text((12, 44), line2, fill="black")  # wrap returns to the LEFT margin (no leading number)
    return im


MUST_ERASE = {
    "dot": lambda: _q(lambda d: d.text((12, 20), "8.", fill="black"), 95),
    "three_digit": lambda: _q(lambda d: d.text((10, 20), "180.", fill="black"), 120),
    "paren": lambda: _q(lambda d: d.text((12, 20), "5)", fill="black"), 95),
    "bracket": lambda: _q(lambda d: d.text((10, 20), "(12)", fill="black"), 110),
    "q_dot": lambda: _q(lambda d: d.text((10, 20), "Q.5", fill="black"), 108),
    "circled_badge": lambda: _q(
        lambda d: (d.ellipse((8, 12, 72, 76), outline="black", width=3),
                   d.text((22, 24), "143", fill="black"), d.text((30, 54), "NM", fill="black")), 100),
    "boxed": lambda: _q(
        lambda d: (d.rectangle((8, 14, 64, 58), outline="black", width=3),
                   d.text((20, 24), "90", fill="black")), 90),
    "tight_indent": lambda: _q(lambda d: d.text((12, 20), "7.", fill="black"), 46),
}

MUST_KEEP = {
    "wide_word": lambda: _content("A capacitor of capacitance 5uF is", "connected as shown in the figure"),
    "short_word": lambda: _content("If a woman is a carrier for", "haemophilia and marries a man"),
    "the_start": lambda: _content("The density of a solid ball is to", "be determined in an experiment"),
    "when_start": lambda: _content("When a body falls freely under", "gravity its acceleration is"),
    "math_start": lambda: _content("x = vt + at gives the displacement", "of a particle in motion"),
    "inline_number": lambda: _content("5 uF and 3 uF capacitors joined", "in parallel across a battery"),
    "numberless_cont": lambda: _content("their target organ correctly and", "also the gland that secretes"),
}


def test_must_erase_battery():
    for name, build in MUST_ERASE.items():
        _, erased, _ = lm.erase(build())
        assert erased, f"leading number/badge must be erased: {name}"


def test_must_keep_battery():
    for name, build in MUST_KEEP.items():
        im = build(); before = _left_ink(im)
        out, erased, _ = lm.erase(im)
        assert not erased, f"content must NOT be erased: {name}"
        assert abs(_left_ink(out) - before) < 1e-6, f"content pixels changed: {name}"


def test_badge_with_options_below_real_layout():
    """The reported live case: a circled badge ('132 NM') tight against an indented stem, with the
    A./B./C. options on lines BELOW at the left margin. The full badge is erased; the options and stem
    are preserved (the badge is a compact multi-line block, the options are further down)."""
    im = Image.new("RGB", (560, 300), "white"); d = ImageDraw.Draw(im)
    d.ellipse((300, 40, 620, 260), outline=(225, 225, 225), width=40)  # faint watermark (ignored)
    d.ellipse((30, 18, 96, 84), outline="black", width=3)
    d.text((40, 30), "132", fill="black"); d.text((48, 60), "NM", fill="black")
    for k, t in enumerate(["Arrange the following steps of", "decomposition in the correct",
                           "sequence leading to formation"]):
        d.text((105, 22 + k * 26), t, fill="black")
    for k, t in enumerate(["A. Fragmentation of detritus", "B. Leaching of soluble substances",
                           "C. Humification", "D. Catabolism", "E. Mineralisation"]):
        d.text((40, 110 + k * 30), t, fill="black")
    badge_pre = float((np.asarray(im.convert("L"))[14:88, 26:100] < 200).mean())
    opts_pre = float((np.asarray(im.convert("L"))[108:270, :] < 200).mean())
    out, erased, _ = lm.erase(im)
    assert erased, "circled badge tight against the stem must be erased"
    assert float((np.asarray(out.convert("L"))[14:88, 26:100] < 200).mean()) < 0.01, "whole badge gone"
    assert badge_pre > 0.05  # sanity: the badge really was there
    assert abs(float((np.asarray(out.convert("L"))[108:270, :] < 200).mean()) - opts_pre) < 1e-6, "options preserved"


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
