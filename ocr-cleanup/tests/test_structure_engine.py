"""Unit + integration tests for the Structural Intelligence Engine.

Pure-stdlib (no cv2/fastapi needed): the structure_engine package only uses dataclasses/
re/statistics, so these run on ANY Python. Run directly (`python tests/test_structure_engine.py`)
or under pytest. Synthetic fixtures exercise each module and all the merge cases.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.structure_engine import analyze_document  # noqa: E402
from app.structure_engine.geometry import compute_metrics  # noqa: E402
from app.structure_engine.models import PageInput  # noqa: E402
from app.structure_engine.page_classifier import classify_page  # noqa: E402
from app.structure_engine import tokens  # noqa: E402

LH = 24       # line height (spacing)
WH = 16       # word/glyph height
PAGE_W = 650
PAGE_H = 900


def W(text, x0, y, w=None):
    return {"text": text, "x0": x0, "y0": y, "x1": x0 + (w if w else len(text) * 8), "y1": y + WH}


def M(num, x0, y, punct="."):
    return {"num": num, "x0": x0, "y0": y, "x1": x0 + 16, "y1": y + WH, "punct": punct}


def line(tokens_xy, y):
    return [W(t, x, y) for (t, x) in tokens_xy]


def page(index, words, markers, width=PAGE_W, height=PAGE_H):
    return {"index": index, "width": width, "height": height, "words": words, "markers": markers}


# ─────────────────────────────────────────────────────────────────────────────
def _q_stem(x0, y, n, prefix=""):
    return [W(f"{n}.", x0, y), W("What", x0 + 24, y), W("is", x0 + 70, y), W("shown", x0 + 100, y), W("here", x0 + 160, y)]


def _opts(x0, ys, style="paren"):
    out = []
    labels = ["1", "2", "3", "4"]
    for lab, y in zip(labels, ys):
        head = f"({lab})" if style == "paren" else f"{lab})"
        out += [W(head, x0, y), W("ans", x0 + 40, y)]
    return out


def fixture_single_column():
    words = []
    markers = []
    # Q1 y40, opts 64..136 ; Q2 y200, opts 224..296 ; Q3 y360, opts 384..456
    for i, base in enumerate((40, 200, 360), start=1):
        n = i
        words += _q_stem(60, base, n)
        words += _opts(80, [base + 24, base + 48, base + 72, base + 96])
        markers.append(M(n, 60, base))
    return {"documentId": "single", "pages": [page(1, words, markers)]}


def fixture_two_column_cross():
    left_x, right_x = 60, 360
    words, markers = [], []
    # LEFT col: Q1 stem spanning many lines (reaches col bottom), NO options in left col
    for k, y in enumerate(range(40, 40 + LH * 9, LH)):
        if k == 0:
            words += _q_stem(left_x, y, 1)
            markers.append(M(1, left_x, y))
        else:
            words += line([("question", left_x), ("body", left_x + 90), ("text", left_x + 160)], y)
    # RIGHT col: options for Q1 at TOP (no marker), then Q2 with its own options
    words += _opts(right_x, [40, 64, 88, 112])
    words += _q_stem(right_x, 160, 2)
    markers.append(M(2, right_x, 160))
    words += _opts(right_x, [184, 208, 232, 256])
    return {"documentId": "twocol", "pages": [page(1, words, markers)]}


def fixture_cross_page():
    words1, markers1 = [], []
    # page1: Q1 at top with options; Q2 near bottom reaching page bottom, NO options here
    words1 += _q_stem(60, 40, 1)
    words1 += _opts(80, [64, 88, 112, 136])
    markers1.append(M(1, 60, 40))
    base2 = 300
    words1 += _q_stem(60, base2, 2)
    words1 += line([("continues", 60), ("to", 150), ("bottom", 190)], base2 + 24)
    markers1.append(M(2, 60, base2))
    p1 = page(1, words1, markers1, height=360)

    words2, markers2 = [], []
    # page2: option lines for Q2 at top (no marker), then Q3
    words2 += _opts(80, [40, 64, 88, 112])
    words2 += _q_stem(60, 160, 3)
    words2 += _opts(80, [184, 208, 232, 256])
    markers2.append(M(3, 60, 160))
    p2 = page(2, words2, markers2)
    return {"documentId": "xpage", "pages": [p1, p2]}


def fixture_sequence_anomalies():
    words, markers = [], []
    for n, base in [(1, 40), (2, 160), (2, 280), (0, 400)]:
        words += _q_stem(60, base, n)
        words += _opts(80, [base + 24, base + 48, base + 72, base + 96])
        markers.append(M(n, 60, base))
    return {"documentId": "seq", "pages": [page(1, words, markers)]}


def fixture_answer_key():
    words = []
    y = 40
    n = 1
    for row in range(12):
        toks = []
        for col in range(5):
            toks.append((f"{n}.", 60 + col * 110))
            toks.append(("a", 60 + col * 110 + 24))
            n += 1
        words += line(toks, y)
        y += LH
    return {"documentId": "key", "pages": [page(1, words, [])]}


# ─────────────────────────────────────────────────────────────────────────────
def _assert(cond, msg):
    if not cond:
        raise AssertionError(msg)


def test_tokens():
    _assert(tokens.is_option_label("(1)"), "paren option")
    _assert(tokens.is_option_label("a)"), "letter option")
    _assert(tokens.is_option_label("B."), "cap option")
    _assert(tokens.option_label_value("(c)") == "c", "label value")
    _assert(not tokens.is_option_label("What"), "word not option")
    _assert(tokens.looks_answer_key("the answer key for paper"), "answer key kw")
    _assert(tokens.count_answerkey_pairs("1. a 2. b 3. c") >= 3, "answer pairs")
    # boolean words are NOT generic option labels (prose-safe), but are detectable with context.
    _assert(not tokens.is_option_label("True"), "boolean not a generic option label")
    _assert(tokens.is_boolean_option("True") and tokens.is_boolean_option("false"), "boolean detectable")
    _assert(tokens.looks_assertion_reason("assertion (a): ... reason (r): ..."), "assertion-reason typed")
    # SEMANTIC families (roman + circled) are GATED OFF by default (roman sub-statement
    # ambiguity) — with the gate ON they are recognised, and prose is still excluded.
    _saved = tokens._SEMANTIC_OPTIONS
    try:
        tokens._SEMANTIC_OPTIONS = False
        _assert(not tokens.is_option_label("(i)"), "roman OFF by default")
        tokens._SEMANTIC_OPTIONS = True
        _assert(tokens.is_option_label("(i)") and tokens.is_option_label("ii)"), "roman option (gated on)")
        _assert(tokens.is_option_label("iv.") and tokens.option_label_value("iv.") == "iv", "roman iv value")
        _assert(not tokens.is_option_label("i.e."), "i.e. is not an option (prose guard)")
        _assert(not tokens.is_option_label("involved"), "roman-prefixed word not an option")
        _assert(tokens.is_option_label("①") and tokens.option_label_value("②") == "2", "circled digit")
        _assert(tokens.is_option_label("Ⓐ") and tokens.option_label_value("ⓒ") == "c", "circled letter")
    finally:
        tokens._SEMANTIC_OPTIONS = _saved
    print("  ok test_tokens")


def test_geometry_columns():
    f = fixture_two_column_cross()
    p = PageInput.from_dict(f["pages"][0])
    m = compute_metrics(p)
    _assert(len(m.columns) == 2, f"expected 2 columns, got {len(m.columns)}")
    f1 = fixture_single_column()
    p1 = PageInput.from_dict(f1["pages"][0])
    m1 = compute_metrics(p1)
    _assert(len(m1.columns) == 1, f"expected 1 column, got {len(m1.columns)}")
    print("  ok test_geometry_columns")


def test_page_classifier():
    fk = fixture_answer_key()
    p = PageInput.from_dict(fk["pages"][0])
    m = compute_metrics(p)
    pc = classify_page(p, m)
    _assert(pc.kind.value == "ANSWER_KEY", f"expected ANSWER_KEY, got {pc.kind}")
    empty = PageInput.from_dict(page(1, [W("x", 10, 10)], []))
    me = compute_metrics(empty)
    _assert(classify_page(empty, me).kind.value == "IGNORE", "empty → IGNORE")
    print("  ok test_page_classifier")


def test_single_column_clean():
    r = analyze_document(fixture_single_column())
    _assert(len(r["questions"]) == 3, f"expected 3 questions, got {len(r['questions'])}")
    nums = [q["number"] for q in r["questions"]]
    _assert(nums == [1, 2, 3], f"numbers {nums}")
    for q in r["questions"]:
        _assert(q["optionCount"] == 4, f"q{q['number']} opts={q['optionCount']}")
        _assert(q["complete"], f"q{q['number']} not complete")
        _assert(not q["needsReview"], f"q{q['number']} flagged: {q['reviewReasons']}")
    _assert(r["recommendation"] == "ACCEPT", f"reco {r['recommendation']} notes={r['notes']}")
    print("  ok test_single_column_clean")


def test_cross_column_merge():
    r = analyze_document(fixture_two_column_cross())
    _assert(len(r["questions"]) == 2, f"expected 2 questions, got {len(r['questions'])}: "
            + str([(q['number'], q['optionCount']) for q in r["questions"]]))
    q1 = next(q for q in r["questions"] if q["number"] == 1)
    _assert(q1["multiColumn"], "Q1 should be multi-column")
    _assert(q1["optionCount"] == 4, f"Q1 options via cross-column = {q1['optionCount']}")
    _assert("CROSS_COLUMN_OPTIONS" in q1["merges"], f"Q1 merges {q1['merges']}")
    print("  ok test_cross_column_merge")


def test_cross_page_merge():
    r = analyze_document(fixture_cross_page())
    nums = sorted(q["number"] for q in r["questions"])
    _assert(nums == [1, 2, 3], f"numbers {nums}")
    q2 = next(q for q in r["questions"] if q["number"] == 2)
    _assert(q2["multiPage"], "Q2 should be multi-page")
    _assert(q2["optionCount"] == 4, f"Q2 options via cross-page = {q2['optionCount']}")
    _assert(any("CROSS_PAGE" in m for m in q2["merges"]), f"Q2 merges {q2['merges']}")
    print("  ok test_cross_page_merge")


def test_sequence_anomalies():
    # markers 1,2,2,0 → the duplicate 2 and the 0 are spurious; the count authority must
    # report 2 logical questions and SURFACE the anomalies (never silently accept them).
    r = analyze_document(fixture_sequence_anomalies())
    seq = r["sequence"]
    _assert(2 in seq["duplicates"], f"duplicates {seq['duplicates']}")
    _assert(seq["questionZero"], "questionZero")
    _assert(r["recommendation"] == "REVIEW", "anomalies → REVIEW")
    qc = r["questionCount"]
    _assert(qc["logicalQuestionCount"] == 2, f"count must drop dup+zero → 2, got {qc['logicalQuestionCount']}")
    _assert(any(a["type"] == "spurious_markers" for a in qc["anomalies"]), f"spurious surfaced: {qc['anomalies']}")
    print("  ok test_sequence_anomalies")


def test_answer_key_no_questions():
    r = analyze_document(fixture_answer_key())
    pc = r["pageClasses"][0]
    _assert(pc["kind"] == "ANSWER_KEY", f"page kind {pc['kind']}")
    _assert(len(r["questions"]) == 0, f"answer-key page should yield 0 questions, got {len(r['questions'])}")
    print("  ok test_answer_key_no_questions")


def test_marker_derivation():
    # same single-column doc but with NO markers supplied → Python must derive them
    f = fixture_single_column()
    for p in f["pages"]:
        p["markers"] = []
    r = analyze_document(f)
    nums = sorted(q["number"] for q in r["questions"])
    _assert(nums == [1, 2, 3], f"derived numbers {nums}")
    for q in r["questions"]:
        _assert(q["optionCount"] == 4, f"derived q{q['number']} opts={q['optionCount']}")
    print("  ok test_marker_derivation")


def fixture_whitespace_gap():
    # Q1 stem, then a LARGE blank gap (diagram area) with NO marker, then options far below.
    words, markers = [], []
    words += _q_stem(60, 40, 1)
    markers.append(M(1, 60, 40))
    # options appear only after a big vertical gap (no marker in between → must NOT split)
    words += _opts(80, [260, 284, 308, 332])
    return {"documentId": "gap", "pages": [page(1, words, markers)]}


def fixture_multiblock_false_start():
    words, markers = [], []
    words += _q_stem(60, 40, 1)
    markers.append(M(1, 60, 40))
    words += _opts(80, [64, 88, 112, 136])
    # a NUMBERLESS token sitting mid-line (a word JUST to its left ⇒ NOT a line start) →
    # false start → must fold into Q1 (MULTI_BLOCK), never open a new question.
    words += [W("continuationline", 60, 170, w=150), W("also", 215, 170)]
    markers.append(M(None, 215, 170, punct="."))
    return {"documentId": "mb", "pages": [page(1, words, markers)]}


def fixture_orphan_options():
    # a page that BEGINS with options (no owner above, no previous page) → orphan → review
    words, markers = [], []
    words += _opts(80, [40, 64, 88, 112])
    words += _q_stem(60, 160, 1)
    words += _opts(80, [184, 208, 232, 256])
    markers.append(M(1, 60, 160))
    return {"documentId": "orphan", "pages": [page(1, words, markers)]}


def test_whitespace_no_split():
    r = analyze_document(fixture_whitespace_gap())
    _assert(len(r["questions"]) == 1, f"whitespace must not split: got {len(r['questions'])}")
    q = r["questions"][0]
    _assert(q["optionCount"] == 4, f"options across the gap = {q['optionCount']}")
    print("  ok test_whitespace_no_split")


def test_multiblock_false_start_fold():
    r = analyze_document(fixture_multiblock_false_start())
    _assert(len(r["questions"]) == 1, f"false start must fold: got {len(r['questions'])}")
    q = r["questions"][0]
    _assert(q["multiBlock"], "Q1 should be multi-block")
    _assert("MULTI_BLOCK" in q["merges"], f"merges {q['merges']}")
    print("  ok test_multiblock_false_start_fold")


def test_orphan_options_fail():
    r = analyze_document(fixture_orphan_options())
    _assert(len(r["orphans"]) >= 1, f"expected orphan options, got {len(r['orphans'])}")
    _assert(r["recommendation"] == "REVIEW", "orphans → REVIEW")
    _assert(r["integrity"]["status"] == "STOP", f"integrity {r['integrity']}")
    print("  ok test_orphan_options_fail")


def test_confidence_tiers():
    # Decision matrix: >=98 TS_LIGHTWEIGHT, 95-97 TS_FULL, <95 REVIEW. A clean question is
    # high-confidence so TS does (at most) lightweight validation — never pure auto-accept.
    from app.structure_engine.confidence_engine import tier_for
    _assert(tier_for(99) == "TS_LIGHTWEIGHT", "99 → lightweight")
    _assert(tier_for(96) == "TS_FULL", "96 → full")
    _assert(tier_for(94) == "REVIEW", "94 → review")
    r = analyze_document(fixture_single_column())
    for q in r["questions"]:
        _assert(q["confidencePct"] >= 95, f"clean q should be high-confidence: {q['confidencePct']}")
        _assert(q["tier"] in ("TS_LIGHTWEIGHT", "TS_FULL"), f"clean q tier {q['tier']}")
        _assert(q["tier"] != "REVIEW", "clean q must not be REVIEW")
    # an anomalous doc must always be REVIEW (never accepted on Python confidence alone)
    ra = analyze_document(fixture_sequence_anomalies())
    _assert(any(q["tier"] == "REVIEW" for q in ra["questions"]), "anomaly → REVIEW")
    print("  ok test_confidence_tiers")


def test_promotion_registry():
    r = analyze_document(fixture_single_column())
    promo = r["promotion"]
    # single Python engine owns ALL document structure incl. crop construction
    for k in (
        "question_count", "ownership_graph", "merge_detection", "cross_column_ownership",
        "cross_page_ownership", "duplicate_detection", "question_zero_detection",
        "impossible_sequence_detection", "crop_construction", "crop_alignment", "crop_repair",
        "crop_validation", "mcq_completeness", "nnc_validation", "diagram_ownership",
        "background_removal", "header_detection", "footer_detection",
    ):
        _assert(promo.get(k) == "PROMOTED", f"{k} should be PROMOTED, got {promo.get(k)}")
    # TS infrastructure / business → never structure
    for k in ("answer_key_logic", "business_rules", "persistence"):
        _assert(promo.get(k) == "NOT_PROMOTED", f"{k} should be NOT_PROMOTED, got {promo.get(k)}")
    print("  ok test_promotion_registry")


def test_integrity_gate():
    clean = analyze_document(fixture_single_column())
    ig = clean["integrity"]
    _assert(ig["status"] == "PASS", f"clean integrity {ig}")
    _assert(ig["nEqualsNEqualsC"], "N=N=C on clean doc")
    _assert(ig["logicalQuestionCount"] == ig["completeQuestionCount"] == 3, f"counts {ig}")
    _assert(not ig["ownershipViolations"], f"no violations {ig['ownershipViolations']}")
    bad = analyze_document(fixture_sequence_anomalies())
    _assert(bad["integrity"]["status"] == "STOP", "anomaly integrity STOP")
    print("  ok test_integrity_gate")


def test_semantic_labels_never_auto_accept():
    # Answer-key / correction / appendix are SEMANTIC candidates: capped < auto-accept,
    # always confidence < 100, flagged candidate=True (Python proposes, TS decides).
    r = analyze_document(fixture_answer_key())
    pc = r["pageClasses"][0]
    _assert(pc["kind"] == "ANSWER_KEY", f"kind {pc['kind']}")
    _assert(pc["candidate"] is True, "semantic label must be a candidate")
    _assert(pc["confidence"] < 1.0, f"semantic conf must be < 100: {pc['confidence']}")
    _assert(pc["confidencePct"] < 95, f"semantic label must never be auto-accept: {pc['confidencePct']}")
    # a geometric QUESTION page is NOT a candidate
    rq = analyze_document(fixture_single_column())
    _assert(rq["pageClasses"][0]["candidate"] is False, "QUESTION page is geometric, not a candidate")
    print("  ok test_semantic_labels_never_auto_accept")


def _recon(markers_spec):
    # markers_spec: list of (value, x, y). Build a page + metrics and reconcile.
    from app.structure_engine.marker_reconciler import reconcile_markers
    words, markers = [], []
    for v, x, y in markers_spec:
        words += [W(f"{v}.", x, y), W("text", x + 30, y), W("body", x + 70, y)]
        markers.append(M(v, x, y))
    p = PageInput.from_dict(page(1, words, markers, width=650, height=1600))
    m = compute_metrics(p)
    return reconcile_markers([p], {1: m})


def test_content_number_demotion():
    from app.structure_engine import content_number as cn
    # forbidden patterns must be rejected as content numbers
    for t in ("2,3-", "1,4-", "70S", "5mL", "10cm", "1st", "2nd", "3rd", "1.5", "3.14", "2-3", "1:2",
              "(i)", "ii)", "iv.", "(iii)"):
        _assert(cn.looks_content_number(t), f"{t!r} must be a content number")
    # genuine question-number shapes must NOT be flagged
    for t in ("1.", "12.", "108.", "1", "108"):
        _assert(not cn.looks_content_number(t), f"{t!r} must NOT be a content number")
    # figure/table/step label context
    for p in ("Figure", "Fig.", "Table", "Step", "Page", "Group"):
        _assert(cn.is_label_context(p), f"{p!r} must be label context")
    _assert(not cn.is_label_context("the"), "'the' is not label context")

    # end-to-end: '70S' and a 'Figure 3' caption at a line start must NOT become questions
    words = []
    words += _q_stem(60, 40, 1)
    words += _opts(80, [64, 88, 112, 136])
    words += [W("70S", 60, 170), W("ribosome", 90, 170)]                  # unit-glued line start
    words += [W("Figure", 60, 200), W("3", 110, 200), W("shows", 128, 200)]  # figure label
    r = analyze_document({"documentId": "cn", "pages": [page(1, words, [])]})
    nums = sorted(q["number"] for q in r["questions"] if q["number"] is not None)
    _assert(nums == [1], f"only Q1 is real; 70S/Figure 3 demoted, got {nums}")
    print("  ok test_content_number_demotion")


def test_marker_reconciler():
    # clean monotonic at one margin → all accepted
    r = _recon([(n, 60, 40 + n * 24) for n in range(1, 7)])
    _assert(r.accepted == 6, f"clean monotonic accepted {r.accepted}")
    _assert(r.demoted_spurious == 0 and r.demoted_offmargin == 0, "no demotions on clean")

    # off-margin spurious (a table number far right) → demoted, count unchanged
    spec = [(n, 60, 40 + n * 24) for n in range(1, 7)] + [(9, 400, 100)]
    r2 = _recon(spec)
    _assert(r2.accepted == 6, f"off-margin must not inflate count: {r2.accepted}")
    _assert(r2.demoted_offmargin == 1, f"off-margin demoted {r2.demoted_offmargin}")

    # section restart (1..5 then 1..5 sustained) → both runs kept
    spec3 = [(n, 60, 40 + n * 24) for n in range(1, 6)] + [(n, 60, 200 + n * 24) for n in range(1, 6)]
    r3 = _recon(spec3)
    _assert(r3.accepted == 10, f"sustained restart kept: {r3.accepted}")
    _assert(r3.restarts == 1, f"restart detected: {r3.restarts}")

    # spurious backward (isolated, not sustained) → demoted as duplicate
    r4 = _recon([(1, 60, 40), (2, 60, 64), (3, 60, 88), (1, 60, 112), (4, 60, 136), (5, 60, 160)])
    _assert(r4.accepted == 5, f"stray backward demoted: {r4.accepted}")
    _assert(1 in r4.duplicates, f"duplicate surfaced: {r4.duplicates}")
    print("  ok test_marker_reconciler")


def test_visual_detectors_token_layer():
    from app.structure_engine import visual_detectors as vd
    from app.structure_engine.geometry import compute_metrics
    from app.structure_engine.models import PageInput, WordBox

    # equation line: math-symbol dense
    eqwords = [W("x", 60, 40), W("=", 80, 40), W("a", 100, 40), W("+", 120, 40), W("b", 140, 40)]
    p = PageInput.from_dict(page(1, eqwords + _q_stem(60, 100, 1), []))
    m = compute_metrics(p)
    _assert(vd.has_equation([WordBox.from_dict(w) for w in eqwords], m), "equation line detected")

    # table grid: 3 rows x 3 aligned columns
    tbl = []
    for r, y in enumerate((40, 64, 88)):
        for x in (60, 200, 340):
            tbl.append(W(f"c{r}", x, y))
    pt = PageInput.from_dict(page(1, tbl, []))
    mt = compute_metrics(pt)
    _assert(vd.has_table([WordBox.from_dict(w) for w in tbl], mt), "word-grid table detected")

    # end-to-end: a question with a big word-free gap (figure between stem and options) → diagram PASS
    words, markers = [], []
    words += _q_stem(60, 40, 1)
    words += _opts(80, [320, 344, 368, 392])   # options far below → ~240px gap = a figure region
    markers.append(M(1, 60, 40))
    r = analyze_document({"documentId": "vis", "pages": [page(1, words, markers)]})
    q = r["questions"][0]
    _assert(q["visuals"]["diagram"] == "PASS", f"diagram detected in the gap: {q['visuals']}")
    _assert(any(h["checks"]["diagram"] == "PASS" for h in r["ownershipHeatmap"]), "heatmap shows owned diagram")
    print("  ok test_visual_detectors_token_layer")


def test_table_not_option_grid():
    from app.structure_engine import visual_detectors as vd
    from app.structure_engine.geometry import compute_metrics
    from app.structure_engine.models import PageInput, WordBox

    # 4 one-per-line options with aligned label/text columns → MCQ layout, NOT a table
    opt = []
    for lab, y in zip(("A)", "B)", "C)", "D)"), (40, 64, 88, 112)):
        opt += [W(lab, 46, y), W("Meter", 66, y), W("unit", 99, y)]
    po = PageInput.from_dict(page(1, opt, []))
    mo = compute_metrics(po)
    _assert(not vd.has_table([WordBox.from_dict(w) for w in opt], mo), "option grid must NOT be a table")

    # a genuine data grid (no option labels in the left column) → table
    tbl = []
    for r, y in enumerate((40, 64, 88, 112)):
        for x in (60, 200, 340):
            tbl += [W(f"d{r}", x, y)]
    pt = PageInput.from_dict(page(1, tbl, []))
    mt = compute_metrics(pt)
    _assert(vd.has_table([WordBox.from_dict(w) for w in tbl], mt), "real data grid IS a table")
    print("  ok test_table_not_option_grid")


def test_staged_nnc():
    # Stage 1 provable now; Stage 2 pending wiring
    r = analyze_document(fixture_single_column())
    nnc = r["integrity"]["nnc"]
    _assert(nnc["stage1"]["pass"], f"stage1 must PASS on clean doc: {nnc['stage1']}")
    _assert(nnc["stage1"]["logicalQuestionCount"] == 3, "stage1 logical count")
    _assert(nnc["stage1"]["logicalQuestionCount"] == nnc["stage1"]["ownershipCount"] == nnc["stage1"]["completeQuestionCount"],
            f"logical==ownership==complete: {nnc['stage1']}")
    _assert(nnc["stage2"]["status"] == "PENDING_WIRING", "stage2 pending until wiring")
    _assert(nnc["status"] == "PASS", "overall = stage1 (delivery not wired)")
    print("  ok test_staged_nnc")


def test_ownership_completeness_gate():
    # clean 3-question doc → every question complete, cropGate PASS
    r = analyze_document(fixture_single_column())
    hm = r["ownershipHeatmap"]
    _assert(len(hm) == 3, f"heatmap per question: {len(hm)}")
    for h in hm:
        _assert(h["checks"]["question_number"] == "PASS", "number owned")
        _assert(h["checks"]["options"] == "PASS", "options owned")
        _assert(h["completeness"] >= 0.95, f"completeness {h['completeness']}")
        _assert(h["cropAllowed"], f"crop allowed for clean q: {h}")
    _assert(r["cropGate"] == "PASS", f"cropGate PASS on clean doc, got {r['cropGate']}")

    # a predominantly 4-option paper where ONE question has only 2 options → missing labels are
    # recorded in `missing` (advisory) but checks["options"]="PASS" (crop has content);
    # cropGate remains PASS — pre_delivery_validator owns the search+gate, not this heatmap.
    words, markers = [], []
    for i, base in enumerate((40, 200, 360), 1):       # 3 full 4-option questions → dominant=4
        words += _q_stem(60, base, i)
        words += _opts(80, [base + 24, base + 48, base + 72, base + 96])
        markers.append(M(i, 60, base))
    words += _q_stem(60, 520, 4)                         # Q4 with only 2 options
    words += _opts(80, [544, 568])
    markers.append(M(4, 60, 520))
    rb = analyze_document({"documentId": "broken", "pages": [page(1, words, markers, height=720)]})
    _assert(rb["questionCount"]["expectedOptionCount"] == 4, f"inferred 4-option paper: {rb['questionCount']['expectedOptionCount']}")
    h4 = next(h for h in rb["ownershipHeatmap"] if h["number"] == 4)
    _assert(h4["checks"]["options"] == "PASS", f"partial options → PASS (advisory): {h4['checks']}")
    _assert("option_3" in h4["missing"] and "option_4" in h4["missing"], f"missing labels still reported: {h4['missing']}")
    _assert(h4["cropAllowed"], f"crop allowed with partial options: {h4}")
    _assert(rb["cropGate"] == "PASS", "cropGate PASS with partial options (pre_delivery_validator gates)")
    print("  ok test_ownership_completeness_gate")


def test_repeated_chrome_no_false_markers():
    # 4 pages, each with a repeated numbered header "99. NEET 2026" at the top (would become a
    # false question marker on every page) + a real question per page. Chrome must demote it.
    pages = []
    for pidx, qn in enumerate((1, 2, 3, 4), 1):
        words = [W("99.", 60, 8), W("NEET", 90, 8), W("2026", 140, 8)]   # repeated top header
        words += _q_stem(60, 200, qn)
        words += _opts(80, [240, 264, 288, 312])
        words += [W(str(pidx), 320, 860)]  # page number footer (changes per page)
        pages.append(page(pidx, words, [], height=900))
    r = analyze_document({"documentId": "chrome", "pages": pages})
    nums = sorted(q["number"] for q in r["questions"] if q["number"] is not None)
    _assert(99 not in nums, f"repeated header '99.' must not be a question: {nums}")
    _assert(nums == [1, 2, 3, 4], f"only the 4 real questions: {nums}")
    print("  ok test_repeated_chrome_no_false_markers")


def test_option_count_inference():
    from app.structure_engine import crop_completeness_validator as cc
    from app.structure_engine.models import QuestionCandidate

    def q(n_opts):
        from app.structure_engine.models import OptionRef
        qq = QuestionCandidate(id="x", number=1, number_confidence=1.0, start_page=1, end_page=1)
        qq.options = [OptionRef(label=str(i), page=1, x0=0, y0=0, x1=1, y1=1) for i in range(n_opts)]
        return qq

    # a predominantly 5-option paper → expected inferred as 5
    five = [q(5), q(5), q(5), q(4)]
    _assert(cc.infer_expected_options(five) == 5, "infer 5-option paper")
    # predominantly 4-option → 4
    four = [q(4), q(4), q(4), q(3)]
    _assert(cc.infer_expected_options(four) == 4, "infer 4-option paper")
    # partial options → complete=True (crop has content; pre_delivery_validator handles search+gate)
    complete, reasons = cc.assess(q(3), expected=4)
    _assert(complete and not any(r.startswith("broken_options") for r in reasons), f"3 of 4 → complete (advisory only): {reasons}")
    # same for 4-of-5
    complete5, _ = cc.assess(q(4), expected=5)
    _assert(complete5, "4 of 5 → complete (partial options not hard_incomplete)")
    # A-E label family recognised
    from app.structure_engine import tokens
    _assert(tokens.is_option_label("E)") and tokens.is_option_label("(e)"), "A-E family recognised")
    print("  ok test_option_count_inference")


def test_missing_question_recovery():
    from app.structure_engine.marker_reconciler import reconcile_markers
    from app.structure_engine.geometry import compute_metrics
    from app.structure_engine.models import PageInput

    def recon(spec):
        words, markers = [], []
        for v, x, y in spec:
            words += [W(f"{v}.", x, y), W("text", x + 30, y), W("body", x + 70, y)]
            markers.append(M(v, x, y))
        p = PageInput.from_dict(page(1, words, markers, width=650, height=2000))
        return reconcile_markers([p], {1: compute_metrics(p)})

    # out-of-order at the margin: reading order 27,30,28,29,31 → 28,29 demoted then RECOVERED.
    spec = [(27, 60, 40), (30, 60, 64), (28, 60, 88), (29, 60, 112), (31, 60, 136)]
    r = recon(spec)
    accepted_vals = sorted(mk.num for mk in r.canonical_by_page[1])
    _assert(accepted_vals == [27, 28, 29, 30, 31], f"all recovered: {accepted_vals}")
    _assert(28 in r.recovered and 29 in r.recovered, f"28,29 recovered: {r.recovered}")
    _assert(r.missing == [], f"no missing after recovery: {r.missing}")

    # a genuine absence (no candidate for the gap) is reported as missing WITH an explanation, never skipped
    spec2 = [(27, 60, 40), (28, 60, 64), (30, 60, 88), (31, 60, 112)]  # 29 truly absent
    r2 = recon(spec2)
    _assert(r2.missing == [29], f"29 reported missing: {r2.missing}")
    _assert(r2.recovered == [], f"nothing to recover: {r2.recovered}")
    print("  ok test_missing_question_recovery")


def test_safe_on_garbage():
    r = analyze_document({"documentId": "g", "pages": [{"index": 1}]})
    _assert(r["recommendation"] in ("ACCEPT", "REVIEW"), "garbage handled")
    _assert(r["questions"] == [], "no questions from empty page")
    r2 = analyze_document({})
    _assert(r2["recommendation"] in ("ACCEPT", "REVIEW"), "empty payload handled")
    _assert(r2["questions"] == [], "empty payload yields no questions")
    print("  ok test_safe_on_garbage")


ALL = [
    test_tokens,
    test_geometry_columns,
    test_page_classifier,
    test_single_column_clean,
    test_cross_column_merge,
    test_cross_page_merge,
    test_sequence_anomalies,
    test_answer_key_no_questions,
    test_marker_derivation,
    test_whitespace_no_split,
    test_multiblock_false_start_fold,
    test_orphan_options_fail,
    test_confidence_tiers,
    test_promotion_registry,
    test_integrity_gate,
    test_semantic_labels_never_auto_accept,
    test_content_number_demotion,
    test_marker_reconciler,
    test_visual_detectors_token_layer,
    test_table_not_option_grid,
    test_staged_nnc,
    test_ownership_completeness_gate,
    test_repeated_chrome_no_false_markers,
    test_option_count_inference,
    test_missing_question_recovery,
    test_safe_on_garbage,
]


def main():
    failures = 0
    for t in ALL:
        try:
            t()
        except Exception as e:  # noqa: BLE001
            failures += 1
            print(f"  FAIL {t.__name__}: {e}")
    total = len(ALL)
    print(f"\n{total - failures}/{total} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
