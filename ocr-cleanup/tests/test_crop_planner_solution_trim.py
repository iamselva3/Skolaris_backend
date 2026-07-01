"""Crop planner — SOLUTION / EXPLANATION must be excluded from a complete-MCQ crop.

Structural + keyword-free: a complete option set ends the question; text below the last option is the
solution and is dropped. A descriptive question (no options) keeps its full content.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.structure_engine.crop_planner import plan_crops  # noqa: E402
from app.structure_engine.models import (  # noqa: E402
    Element,
    ElementKind,
    OptionRef,
    PageInput,
    QuestionCandidate,
)


def _q(qid, options, boxes, number=1):
    return QuestionCandidate(id=qid, number=number, number_confidence=1.0, start_page=1, end_page=1,
                             boxes=boxes, options=options, number_box=[1, 30, 10, 46, 28])


def _txt(y0, y1, x0=40, x1=400):
    return Element(kind=ElementKind.QUESTION_TEXT, page=1, x0=x0, y0=y0, x1=x1, y1=y1, owner_id="q")


def _opts():
    return [
        OptionRef(label="A", page=1, x0=40, y0=100, x1=200, y1=116),
        OptionRef(label="B", page=1, x0=40, y0=120, x1=200, y1=136),
        OptionRef(label="C", page=1, x0=40, y0=140, x1=200, y1=156),
        OptionRef(label="D", page=1, x0=220, y0=100, x1=380, y1=116),
    ]


_PAGES = {1: PageInput(index=1, width=600, height=800)}
_BANDS = {1: (0.0, 0.0)}


def test_solution_excluded_from_complete_mcq():
    # stem (10–30), 4 options (100–156), then a SOLUTION block (200–260) that must be dropped
    q = _q("q1", _opts(), [_txt(10, 30), _txt(200, 260)], number=40)
    plan_crops([q], _PAGES, _BANDS, expected_options=4)
    assert q.crop_regions, "a complete MCQ must still produce a crop"
    assert q.crop_regions[0]["y1"] < 200, "solution block below the options must be excluded"
    assert q.crop_regions[0]["y1"] >= 156, "the option block itself is kept"


def test_descriptive_question_not_trimmed():
    # no options ⇒ the working/answer below the stem is legitimate content, never clipped
    q = _q("q2", [], [_txt(10, 30), _txt(200, 260)], number=5)
    plan_crops([q], _PAGES, _BANDS, expected_options=4)
    assert q.crop_regions[0]["y1"] > 250, "a descriptive question keeps its full content"


def test_no_solution_is_noop():
    # a complete MCQ with NOTHING below the options — the trim must not shrink the crop unexpectedly
    q = _q("q3", _opts(), [_txt(10, 30)], number=7)
    plan_crops([q], _PAGES, _BANDS, expected_options=4)
    assert q.crop_regions[0]["y1"] >= 156, "options are kept when there is no solution"


# ── GENERALIZATION BATTERY — must hold for ALL papers incl. unseen ones ───────────────
def test_cross_column_options_trim_to_lowest_option():
    # A,B,C in the left column, D in the right column; solution below. Trim to the LOWEST option (C@156),
    # never clipping a column, and exclude the solution.
    opts = [
        OptionRef(label="A", page=1, x0=40, y0=100, x1=200, y1=116),
        OptionRef(label="B", page=1, x0=40, y0=120, x1=200, y1=136),
        OptionRef(label="C", page=1, x0=40, y0=140, x1=200, y1=156),
        OptionRef(label="D", page=1, x0=300, y0=100, x1=460, y1=116),
    ]
    q = _q("q", opts, [_txt(10, 30), _txt(210, 280)], number=12)
    plan_crops([q], _PAGES, _BANDS, expected_options=4)
    r = q.crop_regions[0]
    assert r["y1"] < 210 and r["y1"] >= 156, "trim below the lowest option; solution excluded"
    assert r["x1"] >= 460, "both columns kept (right-column option D not clipped)"


def test_diagram_below_options_is_kept():
    # a figure owned BELOW the options must be KEPT (content_bottom = the diagram), solution below it dropped
    boxes = [_txt(10, 30),
             Element(kind=ElementKind.DIAGRAM, page=1, x0=40, y0=200, x1=400, y1=300, owner_id="q"),
             _txt(320, 380)]  # solution after the diagram
    q = _q("q", _opts(), boxes, number=20)
    plan_crops([q], _PAGES, _BANDS, expected_options=4)
    assert q.crop_regions[0]["y1"] >= 300, "the owned diagram below the options is kept"
    assert q.crop_regions[0]["y1"] < 320, "the solution after the diagram is excluded"


def test_multiline_solution_all_excluded():
    boxes = [_txt(10, 30), _txt(200, 220), _txt(225, 245), _txt(250, 290)]  # SOL + working + answer
    q = _q("q", _opts(), boxes, number=33)
    plan_crops([q], _PAGES, _BANDS, expected_options=4)
    assert q.crop_regions[0]["y1"] < 200, "every line of a multi-line solution is excluded"


def test_five_option_paper_trims_after_e():
    opts = [OptionRef(label=l, page=1, x0=40, y0=100 + i * 18, x1=200, y1=114 + i * 18)
            for i, l in enumerate("ABCDE")]
    q = _q("q", opts, [_txt(10, 30), _txt(220, 280)], number=9)
    plan_crops([q], _PAGES, _BANDS, expected_options=5)  # a 5-option paper
    last_e = 114 + 4 * 18
    assert last_e <= q.crop_regions[0]["y1"] < 220, "trim after option E; solution excluded"


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
