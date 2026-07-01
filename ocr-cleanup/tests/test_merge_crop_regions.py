"""Cross-page / cross-column MERGE → ONE question with correct per-piece crop regions.

The user cases: question on one page + options on another; question in one column + options in the next;
part of the question split across columns. Each must MERGE to a single question and emit one crop region
PER PIECE (per page / per column) so TS stitches ONE crop — never split, never spanning the gutter.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.structure_engine.pipeline import analyze_document  # noqa: E402


def _w(items):
    return [{"text": t, "x0": x, "y0": y, "x1": x + ww, "y1": y + 14} for (t, x, y, ww) in items]


def _q(num, x, ystem, withopts=True):
    out = [(f"{num}.", x, ystem, 16), ("Question", x + 22, ystem, 70), ("text", x + 96, ystem, 40)]
    if withopts:
        out += [("(a)", x, ystem + 22, 24), ("aa", x + 28, ystem + 22, 30),
                ("(b)", x + 110, ystem + 22, 24), ("bb", x + 138, ystem + 22, 30),
                ("(c)", x, ystem + 44, 24), ("cc", x + 28, ystem + 44, 30),
                ("(d)", x + 110, ystem + 44, 24), ("dd", x + 138, ystem + 44, 30)]
    return out


def _regions(q):
    return q.get("cropRegions") or []


def test_cross_page_one_question_two_regions():
    p1 = _q(1, 40, 40) + [("2.", 40, 720, 16), ("Define", 70, 720, 50), ("term", 128, 720, 40)]
    p2 = [("(a)", 40, 40, 24), ("p", 68, 40, 18), ("(b)", 150, 40, 24), ("q", 178, 40, 18),
          ("(c)", 40, 62, 24), ("r", 68, 62, 18), ("(d)", 150, 62, 24), ("s", 178, 62, 18)] + _q(3, 40, 130)
    doc = {"documentId": "P", "pages": [
        {"index": 1, "width": 600, "height": 780, "words": _w(p1)},
        {"index": 2, "width": 600, "height": 780, "words": _w(p2)}]}
    a = analyze_document(doc)
    assert [q["number"] for q in a["questions"]] == [1, 2, 3], "count correct, Q2 not lost"
    q2 = next(q for q in a["questions"] if q["number"] == 2)
    assert q2["multiPage"] and q2["optionCount"] == 4, "Q2 merged its page-2 options"
    pages = {r["page"] for r in _regions(q2)}
    assert pages == {1, 2}, "one region on each page (stem p1, options p2) for TS to stitch"


def _two_column_doc():
    L, R = 40, 340
    toks = []
    for i, yy in enumerate([40, 130, 220]):
        toks += _q(i + 1, L, yy)
    toks += _q(4, L, 720, withopts=False)        # Q4 stem at the BOTTOM of the left column
    toks += [("(a)", R, 40, 24), ("aa", R + 28, 40, 30), ("(b)", R + 110, 40, 24), ("bb", R + 138, 40, 30),
             ("(c)", R, 62, 24), ("cc", R + 28, 62, 30), ("(d)", R + 110, 62, 24), ("dd", R + 138, 62, 30)]
    for i, yy in enumerate([130, 220, 310, 400, 490, 580]):
        toks += _q(5 + i, R, yy)
    return {"documentId": "C", "pages": [{"index": 1, "width": 620, "height": 800, "words": _w(toks)}]}


def test_cross_column_one_question_per_column_regions():
    a = analyze_document(_two_column_doc())
    nums = sorted(q["number"] for q in a["questions"] if q["number"])
    assert nums == list(range(1, 11)), f"all 10 questions counted: {nums}"
    q4 = next(q for q in a["questions"] if q["number"] == 4)
    assert q4["multiColumn"] and q4["optionCount"] == 4, "Q4 merged its right-column options"
    regs = _regions(q4)
    lefts = [r for r in regs if r["x0"] < 300]
    rights = [r for r in regs if r["x0"] >= 300]
    assert lefts and rights, "one region in EACH column (left stem + right options)"
    # the left (stem) region must not span into the right column (no gutter-spanning box)
    assert max(r["x1"] for r in lefts) < 320, "left-column region stays in the left column"
    assert min(r["x0"] for r in rights) >= 320, "right-column region stays in the right column"


def test_neighbours_not_merged():
    # the questions around a cross-column merge stay independent (no over-merge)
    a = analyze_document(_two_column_doc())
    for n in (1, 2, 3, 5, 6):
        q = next(x for x in a["questions"] if x["number"] == n)
        assert q["optionCount"] == 4 and not q.get("multiColumn"), f"Q{n} is its own single-column question"


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
