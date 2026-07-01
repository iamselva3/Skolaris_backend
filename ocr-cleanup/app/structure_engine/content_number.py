"""Content-number demotion — tokens that look numeric but are NEVER question starts.

A robust question-number engine must reject, by token SHAPE and neighbour context (not
coordinates, not PDF specifics): sub-list / option numbers, roman option labels, matrix
numbers, equation numbers, chemical locants, units glued to digits, ordinals, and figure
/ table / scheme labels. These are universal structural patterns, not per-document tuning.

Pure string/neighbour predicates. Independently testable.
"""
from __future__ import annotations

import re

# roman option label: (i) ii) iv. — lower/upper roman followed by an option terminator
_ROMAN = re.compile(r"^[\(\[]?\s*(x{0,3}(ix|iv|v?i{1,3}|v))\s*[\)\].:]\s*$", re.IGNORECASE)
# chemical locant: 2,3-  1,4-  2,2'-  (digit, comma/quote, digit, dash)
_LOCANT = re.compile(r"^\d{1,2}[,'’]\s*\d")
# unit / ribosome / glued: 70S, 5mL, 10cm, 3a (digit immediately followed by a letter)
_UNIT_GLUED = re.compile(r"^\d{1,3}[a-zA-Z]")
# ordinal: 1st 2nd 3rd 4th
_ORDINAL = re.compile(r"^\d{1,3}(st|nd|rd|th)\b", re.IGNORECASE)
# pure decimal / range / ratio: 1.5  3.14  2-3  1:2  (a number that is part of a value). A real decimal's
# fractional part is ALL digits — so '108.0bserve' / '151.1f' (OCR read the first letter O/I as 0/1 and
# glued it) is NOT a decimal but a question number glued to its word; the `(?![A-Za-z])` keeps those out.
_DECIMAL = re.compile(r"^\d+\.\d+(?![A-Za-z])")
_RANGE = re.compile(r"^\d+\s*[-:/]\s*\d")

# words that, when immediately to the LEFT of a number, make it a label not a question
_LABEL_WORDS = {
    "figure", "fig", "fig.", "figures", "table", "tbl", "scheme", "plate", "chart",
    "graph", "diagram", "eq", "eqn", "equation", "step", "stage", "phase", "group",
    "column", "col", "row", "page", "section", "exercise", "example", "note", "rule",
    "axis", "level", "type", "class", "no", "no.", "sr", "sr.", "q.no",
}


def looks_content_number(text: str) -> bool:
    """True when a token's SHAPE marks it as a non-question number (locant / unit / roman /
    ordinal / decimal / range / ratio)."""
    t = (text or "").strip()
    if not t:
        return False
    return bool(
        _ROMAN.match(t)
        or _LOCANT.match(t)
        or _UNIT_GLUED.match(t)
        or _ORDINAL.match(t)
        or _DECIMAL.match(t)
        or _RANGE.match(t)
    )


def is_label_context(prev_text: str) -> bool:
    """True when the token immediately to the left marks the number as a label
    (`Figure 3`, `Table 2`, `Step 1`, `Page 4`)."""
    p = (prev_text or "").strip().lower().rstrip(".:)")
    return p in _LABEL_WORDS
