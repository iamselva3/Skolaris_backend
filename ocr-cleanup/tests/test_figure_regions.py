"""Figure-aware cropping — a diagram/figure must never spawn phantom options nor be sliced by a crop.

Locks the three guarantees of the figure pass:
  1. an option-shaped LABEL that sits inside a detected figure region is NOT counted as an MCQ option
     (a diagram's point/axis/vertex label "A"/"C"/"B" — the "OCR read the diagram letter as an option" bug);
  2. a detected figure is OWNED by the question whose column-slab encloses it;
  3. the crop planner keeps an owned figure WHOLE — it is never cut through, even when a (spurious or real)
     next-marker slab would otherwise land inside it.

Pure structure; no PDF/institute constant. detect_figure_regions itself (the pixel pass) is exercised on a
synthetic render so the suite needs no sample PDF.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.structure_engine import figure_regions as FR  # noqa: E402
from app.structure_engine.crop_planner import plan_crops  # noqa: E402
from app.structure_engine.geometry import compute_metrics  # noqa: E402
from app.structure_engine.models import (  # noqa: E402
    Element,
    ElementKind,
    PageInput,
    QuestionCandidate,
    WordBox,
)
from app.structure_engine.option_owner_detector import find_option_lines  # noqa: E402


# ── 1) a label inside a figure box is not an option ───────────────────────────────────
def _page_with_two_labels() -> PageInput:
    # Two option-shaped tokens, each first-on-its-line (a clear gap-start): one in open text, one that sits
    # inside a diagram. Build enough plain words so compute_metrics has a sane char_w / median_h.
    words = [WordBox(text="word%d" % i, x0=40 + (i % 3) * 60, y0=40 + (i // 3) * 20,
                     x1=90 + (i % 3) * 60, y1=56 + (i // 3) * 20) for i in range(12)]
    words.append(WordBox(text="(a)", x0=40, y0=300, x1=64, y1=316))   # real option, open text
    words.append(WordBox(text="(c)", x0=300, y0=360, x1=324, y1=376))  # label INSIDE a figure
    return PageInput(index=1, width=600, height=800, words=words)


def test_label_inside_figure_is_not_an_option():
    p = _page_with_two_labels()
    m = compute_metrics(p)
    figure = (280.0, 340.0, 460.0, 460.0)  # encloses the "(c)" at (300,360)

    without = {ol.label for ol in find_option_lines(p.words, m)}
    withfig = {ol.label for ol in find_option_lines(p.words, m, [figure])}

    assert "c" in without, "control: the (c) label is an option when no figure is known"
    assert "c" not in withfig, "a label inside a figure must NOT be counted as an option"
    assert "a" in withfig, "an option in open text is unaffected by the figure filter"


# ── 2) ownership: a figure is attached to the slab that encloses it ───────────────────
def _q(qid, num, y):
    return QuestionCandidate(id=qid, number=num, number_confidence=1.0, start_page=1, end_page=1,
                             boxes=[Element(kind=ElementKind.QUESTION_TEXT, page=1, x0=40, y0=y, x1=400,
                                            y1=y + 16, owner_id=qid)],
                             number_box=[1, 40, y, 60, y + 16])


def test_figure_owned_by_enclosing_slab():
    p = PageInput(index=1, width=600, height=800,
                  words=[WordBox(text="x", x0=40, y0=10 + i * 5, x1=50, y1=20 + i * 5) for i in range(8)])
    m = compute_metrics(p)
    metrics_by_page = {1: m}
    q1 = _q("q1", 1, 100)
    q2 = _q("q2", 2, 500)
    figs = {1: [(200.0, 122.0, 360.0, 360.0)]}  # right under q1's stem (y100-116) ⇒ belongs to q1

    n = FR.assign_figures_to_questions([q1, q2], figs, metrics_by_page)
    assert n == 1
    assert any(b.kind == ElementKind.DIAGRAM for b in q1.boxes), "figure attached to the enclosing question"
    assert not any(b.kind == ElementKind.DIAGRAM for b in q2.boxes), "the later question never claims it"
    assert q1.has_diagram is True


def test_figure_across_a_gap_is_not_claimed():
    # A figure far BELOW the question's text (the next, missing-number question's figure) must NOT be pulled
    # in — that is the "circuit dragged into the previous question" bleed.
    p = PageInput(index=1, width=600, height=800,
                  words=[WordBox(text="x", x0=40, y0=10 + i * 5, x1=50, y1=20 + i * 5) for i in range(8)])
    m = compute_metrics(p)
    q1 = _q("q1", 1, 100)  # text y100-116
    figs = {1: [(200.0, 400.0, 360.0, 520.0)]}  # a clear gap below q1's text ⇒ left unowned
    n = FR.assign_figures_to_questions([q1], figs, {1: m})
    assert n == 0
    assert not any(b.kind == ElementKind.DIAGRAM for b in q1.boxes)


# ── 3) the crop keeps an owned figure whole, even against a slab that would cut it ────
_PAGES = {1: PageInput(index=1, width=600, height=800)}
_BANDS = {1: (0.0, 0.0)}


def test_crop_not_sliced_through_owned_figure():
    # q1 has a stem (y10-30) then a DIAGRAM (y120-300); q2's marker is BELOW the figure (y350). The crop's
    # own-box bottom (the stem) would stop the crop at ~30, dropping the figure entirely. Figure protection
    # must extend the crop down through the whole owned figure (>=300), while staying above the next
    # question's marker (the slab) — so the diagram is delivered with q1, never cut off.
    q1 = QuestionCandidate(
        id="q1", number=1, number_confidence=1.0, start_page=1, end_page=1, number_box=[1, 30, 10, 46, 28],
        boxes=[Element(kind=ElementKind.QUESTION_TEXT, page=1, x0=40, y0=10, x1=400, y1=30, owner_id="q1"),
               Element(kind=ElementKind.DIAGRAM, page=1, x0=60, y0=120, x1=380, y1=300, owner_id="q1")],
    )
    q2 = QuestionCandidate(
        id="q2", number=2, number_confidence=1.0, start_page=1, end_page=1, number_box=[1, 30, 350, 46, 368],
        boxes=[Element(kind=ElementKind.QUESTION_TEXT, page=1, x0=40, y0=350, x1=400, y1=370, owner_id="q2")],
    )
    plan_crops([q1, q2], _PAGES, _BANDS, expected_options=4, metrics_by_page={})
    assert q1.crop_regions, "q1 must still produce a crop"
    assert q1.crop_regions[0]["y1"] >= 300, "the owned figure must be kept whole (extended through the diagram)"
    assert q1.crop_regions[0]["y1"] < 350, "but never past the next question's marker"


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
