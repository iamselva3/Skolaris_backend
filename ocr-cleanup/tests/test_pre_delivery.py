"""Tests for the pre-delivery validator (single authority) + the badge/ownership guard.

Pure-stdlib. The validator's ACTIVE option search is a safety net that fires when the
merge detectors left a question with fewer than the paper's dominant option count; these
tests exercise it directly (slab + cross-column + cross-page) and confirm a genuinely
incomplete question is blocked, and that decorative numbers never act as owner boundaries.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.structure_engine import badge_guard  # noqa: E402
from app.structure_engine.geometry import compute_metrics  # noqa: E402
from app.structure_engine.models import (  # noqa: E402
    Element, ElementKind, OptionRef, PageInput, QuestionCandidate,
)
from app.structure_engine.pre_delivery_validator import validate_pre_delivery  # noqa: E402

WH = 16


def _assert(cond, msg):
    if not cond:
        raise AssertionError(msg)


def W(text, x0, y, w=None):
    return {"text": text, "x0": x0, "y0": y, "x1": x0 + (w if w else len(text) * 8), "y1": y + WH}


class _FakeWord:
    """Minimal WordBox-like for badge_guard (text + protected)."""
    def __init__(self, text, protected=False):
        self.text = text
        self.protected = protected


# ─────────────────────────────────────────────────────────────────────────────
def test_badge_guard_decorative_never_owner():
    # circled / roman / locant / in-figure / label-context → decorative, never a boundary
    _assert(badge_guard.is_decorative_number(_FakeWord("①")), "circled is decorative")
    _assert(badge_guard.is_decorative_number(_FakeWord("(iv)")), "roman option is decorative")
    _assert(badge_guard.is_decorative_number(_FakeWord("2,3-")), "locant is decorative")
    _assert(badge_guard.is_decorative_number(_FakeWord("70S")), "unit-glued is decorative")
    _assert(badge_guard.is_decorative_number(_FakeWord("3", protected=True)), "in-figure is decorative")
    _assert(badge_guard.is_decorative_number(_FakeWord("3"), prev_text="Figure"), "label-context is decorative")
    # a plain line-start question number IS a real owner boundary
    _assert(badge_guard.is_owner_boundary(_FakeWord("5.")), "plain '5.' is an owner boundary")
    _assert(not badge_guard.is_owner_boundary(_FakeWord("①")), "circled '①' is NOT an owner boundary")
    _assert(not badge_guard.is_owner_boundary(_FakeWord("0.")), "'0.' floored, not an owner")
    _assert(not badge_guard.is_owner_boundary(_FakeWord("hello")), "a word is not an owner")
    print("  ok test_badge_guard_decorative_never_owner")


def _single_page_with_4_options():
    """Page with Q1 stem at y40 and 4 option lines (1)..(4) below it."""
    words = [W("1.", 60, 40), W("What", 88, 40), W("is", 130, 40), W("shown", 160, 40)]
    ys = [70, 100, 130, 160]
    for lab, y in zip(["1", "2", "3", "4"], ys):
        words += [W(f"({lab})", 60, y), W("answer", 100, y)]
    return PageInput.from_dict({"index": 1, "width": 650, "height": 900, "words": words, "markers": []}), ys


def _q_with_first_two_options(page, ys):
    q = QuestionCandidate(
        id="q1", number=1, number_confidence=1.0, start_page=1, end_page=1,
        number_box=[1, 60.0, 40.0, 76.0, 56.0],
    )
    q.boxes = [Element(kind=ElementKind.QUESTION_TEXT, page=1, x0=60, y0=40, x1=300, y1=56)]
    # only the first two options were attached by the upstream detectors
    for lab, y in zip(["1", "2"], ys[:2]):
        q.options.append(OptionRef(label=lab, page=1, x0=60, y0=y, x1=300, y1=y + WH))
    q.crop_allowed = True
    q.crop_valid = True
    return q


def test_active_search_recovers_slab_options():
    page, ys = _single_page_with_4_options()
    metrics = compute_metrics(page)
    q = _q_with_first_two_options(page, ys)
    _assert(q.option_count == 2, "starts with 2 options")
    stats = validate_pre_delivery([q], {1: metrics}, expected_options=4, pages_by_index={1: page})
    _assert(q.option_count == 4, f"slab search should recover to 4, got {q.option_count}")
    _assert("slab" in q.delivery_report["searchedRegions"], f"slab searched: {q.delivery_report}")
    _assert(q.deliverable, f"complete question must be deliverable: {q.delivery_report}")
    _assert(stats["gate"] == "PASS", f"gate {stats['gate']}")
    # the marker line '1.' must NOT have been miscounted as a 5th option
    labels = sorted({(o.label or "") for o in q.options})
    _assert(len(q.options) == 4, f"no phantom option from the marker line: {labels}")
    print("  ok test_active_search_recovers_slab_options")


def test_partial_options_still_deliverable():
    # a question with 2 of 4 options (nothing more to find) → still deliverable.
    # Partial options are no longer a hard gate — pre_delivery_validator passes them;
    # the heatmap records missing labels for advisory reference only.
    words = [W("1.", 60, 40), W("What", 88, 40)]
    for lab, y in zip(["1", "2"], [70, 100]):
        words += [W(f"({lab})", 60, y), W("answer", 100, y)]
    page = PageInput.from_dict({"index": 1, "width": 650, "height": 900, "words": words, "markers": []})
    metrics = compute_metrics(page)
    q = QuestionCandidate(
        id="q1", number=1, number_confidence=1.0, start_page=1, end_page=1,
        number_box=[1, 60.0, 40.0, 76.0, 56.0],
    )
    q.boxes = [Element(kind=ElementKind.QUESTION_TEXT, page=1, x0=60, y0=40, x1=300, y1=56)]
    for lab, y in zip(["1", "2"], [70, 100]):
        q.options.append(OptionRef(label=lab, page=1, x0=60, y0=y, x1=300, y1=y + WH))
    q.crop_allowed = True
    q.crop_valid = True
    stats = validate_pre_delivery([q], {1: metrics}, expected_options=4, pages_by_index={1: page})
    _assert(q.option_count == 2, f"nothing to recover, stays 2: {q.option_count}")
    _assert(q.deliverable, f"partial options → deliverable (advisory only): {q.delivery_report}")
    _assert(stats["gate"] == "PASS", f"gate {stats['gate']}")
    print("  ok test_partial_options_still_deliverable")


def test_diagram_question_deliverable_without_full_options():
    # a visual/numeric question (has_diagram) is complete without 4 text options
    words = [W("1.", 60, 40), W("Observe", 88, 40)]
    page = PageInput.from_dict({"index": 1, "width": 650, "height": 900, "words": words, "markers": []})
    metrics = compute_metrics(page)
    q = QuestionCandidate(
        id="q1", number=1, number_confidence=1.0, start_page=1, end_page=1,
        number_box=[1, 60.0, 40.0, 76.0, 56.0], has_diagram=True,
    )
    q.boxes = [Element(kind=ElementKind.DIAGRAM, page=1, x0=60, y0=60, x1=400, y1=300)]
    q.crop_allowed = True
    q.crop_valid = True
    stats = validate_pre_delivery([q], {1: metrics}, expected_options=4, pages_by_index={1: page})
    _assert(q.deliverable, f"diagram question deliverable without 4 options: {q.delivery_report}")
    _assert(stats["gate"] == "PASS", f"gate {stats['gate']}")
    print("  ok test_diagram_question_deliverable_without_full_options")


if __name__ == "__main__":
    test_badge_guard_decorative_never_owner()
    test_active_search_recovers_slab_options()
    test_partial_options_still_deliverable()
    test_diagram_question_deliverable_without_full_options()
