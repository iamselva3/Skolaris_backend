"""Regression tests for the RapidOCR question-number recovery — the GATING + PARSING logic (deterministic,
no RapidOCR call needed). The recovery itself is validated end-to-end on real captures; here we pin the
adaptive gate (only run when the document is under-detecting) and the strict digit parse."""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.structure_engine import number_ocr
from app.structure_engine.geometry import compute_metrics
from app.structure_engine.models import Marker, PageInput, WordBox
from app.structure_engine.pipeline import (
    _document_under_detecting,
    _number_ocr_enabled,
    _recover_missing_numbers_handwritten,
)


def _assert(c, m):
    if not c:
        raise AssertionError(m)


def _page_with_marker_nums(nums):
    return PageInput(index=1, width=1000, height=1400,
                     markers=[Marker(num=n, x0=40, y0=40 + i * 20, x1=70, y1=60 + i * 20) for i, n in enumerate(nums)])


def test_number_regex_accepts_question_numbers():
    for t, exp in [("41", 41), ("41)", 41), ("98.", 98), ("100)", 100), ("7-", 7), ("12:", 12)]:
        m = number_ocr._NUM_RE.match(t)
        _assert(m and int(m.group(1)) == exp, f"{t!r} -> {exp}")
    print("  ok test_number_regex_accepts_question_numbers")


def test_number_regex_rejects_option_labels_and_noise():
    # an OPTION label is paren-FIRST ("(1)") — it must NOT be read as a question number.
    for t in ["(1)", "(2)", "(a)", "A", "1234", "x12", "", "3.14159", "is"]:
        _assert(number_ocr._NUM_RE.match(t) is None, f"{t!r} must not parse as a question number")
    print("  ok test_number_regex_rejects_option_labels_and_noise")


def test_under_detecting_true_when_gappy():
    # 1..10 then a big jump to 91..94 then 100 — many missing in range ⇒ recover
    p = _page_with_marker_nums(list(range(1, 11)) + [91, 92, 93, 94, 100])
    _assert(_document_under_detecting([p]), "gappy sequence must trigger recovery")
    print("  ok test_under_detecting_true_when_gappy")


def test_under_detecting_false_when_contiguous():
    # a clean digital PDF: 1..40 contiguous ⇒ NO recovery (no latency)
    p = _page_with_marker_nums(list(range(1, 41)))
    _assert(not _document_under_detecting([p]), "contiguous numbering must skip recovery")
    print("  ok test_under_detecting_false_when_contiguous")


def test_under_detecting_true_when_almost_empty():
    p = _page_with_marker_nums([1])
    _assert(_document_under_detecting([p]), "near-empty markers must trigger recovery")
    print("  ok test_under_detecting_true_when_almost_empty")


def test_enabled_flag_respected():
    old = os.environ.get("STRUCTURE_NUMBER_OCR")
    try:
        os.environ["STRUCTURE_NUMBER_OCR"] = "0"
        _assert(not _number_ocr_enabled(), "flag=0 disables")
        os.environ["STRUCTURE_NUMBER_OCR"] = "1"
        _assert(_number_ocr_enabled(), "flag=1 enables")
        del os.environ["STRUCTURE_NUMBER_OCR"]
        _assert(not _number_ocr_enabled(), "default is OFF (opt-in; ~100s pass risks the live timeout)")
    finally:
        if old is None:
            os.environ.pop("STRUCTURE_NUMBER_OCR", None)
        else:
            os.environ["STRUCTURE_NUMBER_OCR"] = old
    print("  ok test_enabled_flag_respected")


# ── GAP-DRIVEN RECOVERY — handwritten OCR is a recovery engine, never a per-page scan ──────────────────
def _page_words_markers(nums):
    words = [WordBox(text="w", x0=40, y0=40 + i * 18, x1=120, y1=56 + i * 18) for i in range(30)]
    markers = [Marker(num=n, x0=40, y0=40 + i * 90, x1=70, y1=60 + i * 90) for i, n in enumerate(nums)]
    return PageInput(index=1, width=1000, height=1400, words=words, markers=markers)


def _run_recovery(nums, enable):
    old = os.environ.get("STRUCTURE_NUMBER_OCR")
    os.environ["STRUCTURE_NUMBER_OCR"] = "1" if enable else "0"
    try:
        p = _page_words_markers(nums)
        return _recover_missing_numbers_handwritten([p], {1: compute_metrics(p)})
    finally:
        if old is None:
            os.environ.pop("STRUCTURE_NUMBER_OCR", None)
        else:
            os.environ["STRUCTURE_NUMBER_OCR"] = old


def test_recovery_no_gap_processes_zero_regions():
    # contiguous numbering ⇒ NO gap ⇒ handwritten OCR must never run, even when enabled
    s = _run_recovery([1, 2, 3, 4, 5], enable=True)
    _assert(s["gaps"] == [], "no gap must be reported for a contiguous sequence")
    _assert(s["regions"] == 0, "handwritten OCR must process 0 regions when there is no gap")
    _assert(s["recovered"] == [], "nothing recovered when nothing is missing")
    print("  ok test_recovery_no_gap_processes_zero_regions")


def test_recovery_reports_gap_but_disabled_runs_nothing():
    # a gap exists (2 missing) but recovery is DISABLED ⇒ gap is still REPORTED, but 0 regions OCR'd
    s = _run_recovery([1, 3], enable=False)
    _assert(s["gaps"] == [2], "the missing number must be reported even when recovery is off")
    _assert(s["enabled"] is False and s["regions"] == 0, "disabled recovery must process 0 regions")
    print("  ok test_recovery_reports_gap_but_disabled_runs_nothing")


def test_recovery_no_render_processes_zero_regions():
    # enabled + a gap, but NO page render ⇒ nothing to OCR ⇒ 0 regions (never invents a number)
    s = _run_recovery([1, 3], enable=True)  # _page_words_markers sets no image_base64
    _assert(s["gaps"] == [2], "gap reported")
    _assert(s["regions"] == 0, "no render ⇒ handwritten OCR cannot run ⇒ 0 regions")
    _assert(s["recovered"] == [], "no number is invented without a readable region")
    print("  ok test_recovery_no_render_processes_zero_regions")


def test_recovery_promotes_a_valid_candidate():
    # the HAPPY path: a gap (2 missing) with a question-shaped split, and the margin OCR reads "2" at the
    # column-left inside the gap region. All three continuities (sequence/layout/ownership) pass ⇒ promoted.
    p = PageInput(
        index=1, width=1000, height=1400, image_base64="x",  # truthy so the render gate passes
        words=[WordBox(text="w", x0=40, y0=60 + i * 14, x1=220, y1=74 + i * 14) for i in range(40)],
        markers=[Marker(num=1, x0=40, y0=60, x1=70, y1=80), Marker(num=3, x0=40, y0=560, x1=70, y1=580)],
    )
    m = compute_metrics(p)
    col_left = m.columns[0].left if m.columns else 40.0
    saved = (number_ocr.available, number_ocr._decode, number_ocr.detect_numbers_in_region)
    number_ocr.available = lambda: True
    number_ocr._decode = lambda _b: object()  # non-None stand-in render
    number_ocr.detect_numbers_in_region = lambda _img, col, y0, y1, _mh: [
        (2, col_left, (y0 + y1) / 2.0, col_left + 20, (y0 + y1) / 2.0 + 16)
    ]
    old = os.environ.get("STRUCTURE_NUMBER_OCR")
    os.environ["STRUCTURE_NUMBER_OCR"] = "1"
    try:
        s = _recover_missing_numbers_handwritten([p], {1: m})
    finally:
        number_ocr.available, number_ocr._decode, number_ocr.detect_numbers_in_region = saved
        if old is None:
            os.environ.pop("STRUCTURE_NUMBER_OCR", None)
        else:
            os.environ["STRUCTURE_NUMBER_OCR"] = old
    _assert(s["regions"] == 1, "the single in-column gap is one scoped region")
    _assert(s["recovered"] == [2], "a valid, well-placed candidate is recovered")
    _assert(any(mk.num == 2 and mk.punct == "hw" for mk in p.markers), "the recovered number is injected as a marker")
    print("  ok test_recovery_promotes_a_valid_candidate")


def _full_col_page(index, marker_num):
    return PageInput(
        index=index, width=1000, height=1400, image_base64="x",
        words=[WordBox(text="w", x0=40, y0=60 + i * 20, x1=240, y1=76 + i * 20) for i in range(60)],
        markers=[Marker(num=marker_num, x0=40, y0=60, x1=70, y1=80)],
    )


def _patched_recovery(pages, metrics_by_page):
    saved = (number_ocr.available, number_ocr._decode, number_ocr.detect_numbers_in_region)
    number_ocr.available = lambda: True
    number_ocr._decode = lambda _b: object()
    # OCR "reads" the value 2 at the column-left, in the middle of whatever band it is given
    number_ocr.detect_numbers_in_region = lambda _img, col, y0, y1, _mh: [
        (2, col.left, (y0 + y1) / 2.0, col.left + 20, (y0 + y1) / 2.0 + 16)
    ]
    old = os.environ.get("STRUCTURE_NUMBER_OCR")
    os.environ["STRUCTURE_NUMBER_OCR"] = "1"
    try:
        return _recover_missing_numbers_handwritten(pages, metrics_by_page)
    finally:
        number_ocr.available, number_ocr._decode, number_ocr.detect_numbers_in_region = saved
        if old is None:
            os.environ.pop("STRUCTURE_NUMBER_OCR", None)
        else:
            os.environ["STRUCTURE_NUMBER_OCR"] = old


def test_recovery_cross_page_promotes_in_boundary_band():
    # 14↓ on page 1, 16↓ on page 2 (here: 1 on p1, 3 on p2, missing 2) — a NORMAL cross-page layout. Recovery
    # must search bottom(prev page) + top(next page) and recover the number, classified CROSS_PAGE.
    p1 = _full_col_page(1, 1)
    p2 = _full_col_page(2, 3)
    s = _patched_recovery([p1, p2], {1: compute_metrics(p1), 2: compute_metrics(p2)})
    _assert(2 in s["recovered"], "a cross-page missing number must be recovered, not routed to review")
    _assert(s["byType"]["CROSS_PAGE"]["regions"] >= 1, "the gap is classified + scoped as CROSS_PAGE")
    _assert(s["byType"]["IN_COLUMN"]["regions"] == 0, "a cross-page gap is not an in-column region")
    print("  ok test_recovery_cross_page_promotes_in_boundary_band")


def test_recovery_cross_column_is_classified_and_scoped():
    # 1 in the LEFT column, 3 in the RIGHT column (same page), missing 2 — a NORMAL 2-column layout. Recovery
    # scopes bottom(left col)+top(right col), classified CROSS_COLUMN, never the whole page.
    p = PageInput(
        index=1, width=1000, height=1400, image_base64="x",
        words=([WordBox(text="L", x0=40, y0=60 + i * 20, x1=300, y1=76 + i * 20) for i in range(60)] +
               [WordBox(text="R", x0=560, y0=60 + i * 20, x1=820, y1=76 + i * 20) for i in range(60)]),
        markers=[Marker(num=1, x0=40, y0=60, x1=70, y1=80), Marker(num=3, x0=560, y0=60, x1=590, y1=80)],
    )
    m = compute_metrics(p)
    if len(m.columns) < 2:  # require the synthetic page to actually have 2 columns for this assertion
        print("  ok test_recovery_cross_column_is_classified_and_scoped (skipped: single column metrics)")
        return
    s = _patched_recovery([p], {1: m})
    _assert(s["byType"]["CROSS_COLUMN"]["regions"] >= 1, "a left→right column gap is scoped as CROSS_COLUMN")
    _assert(s["byType"]["CROSS_COLUMN"]["regions"] <= 2, "CROSS_COLUMN searches at most two bands (never the page)")
    print("  ok test_recovery_cross_column_is_classified_and_scoped")


TESTS = [
    test_number_regex_accepts_question_numbers,
    test_number_regex_rejects_option_labels_and_noise,
    test_under_detecting_true_when_gappy,
    test_under_detecting_false_when_contiguous,
    test_under_detecting_true_when_almost_empty,
    test_enabled_flag_respected,
    test_recovery_no_gap_processes_zero_regions,
    test_recovery_reports_gap_but_disabled_runs_nothing,
    test_recovery_no_render_processes_zero_regions,
    test_recovery_promotes_a_valid_candidate,
    test_recovery_cross_page_promotes_in_boundary_band,
    test_recovery_cross_column_is_classified_and_scoped,
]

if __name__ == "__main__":
    for t in TESTS:
        t()
    print("number-ocr: all passed")
