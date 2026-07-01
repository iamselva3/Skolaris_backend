"""Badge / decorative-number guard — the single predicate for "this number is NOT a
question owner".

A circled / boxed / in-figure number (a diagram point label, a circuit binary digit, a
chemical locant, a unit "70S", a figure caption "Fig 3", an option bullet "①") must stay
PART of the question content. It must never:
  - create a new question owner, or
  - act as a boundary that stops a crop / an option search early.

The marker extractor already rejects most of these when DERIVING markers; this module
re-states the rule as ONE shared predicate so the pre-delivery validator's active option
search enforces it identically — the search must keep going past a decorative number and
stop only at a REAL next owner.

Pure token + neighbour + geometry predicates; no pixels. Builds on content_number.py and
tokens.py so the vocabulary stays in one place.
"""
from __future__ import annotations

import re
from typing import Any, Optional

from . import content_number, tokens

# Canonical question-number shapes (mirror marker_extractor._NUM_DOT / _Q_PREFIX so the
# guard and the extractor agree on what "looks like a number marker" means).
_NUM_DOT = re.compile(r"^(\d{1,3})[.,:;·](?!\d+(?![A-Za-z]))")
_Q_PREFIX = re.compile(r"^[Qq]\.?-?\s*(\d{1,3})\b")
_LEAD_NOISE = "'\"`*•·.-—– "


def looks_number_marker(text: str) -> bool:
    """True when a token has the SHAPE of a question-number marker ('12.', 'Q5')."""
    t = (text or "").strip().lstrip(_LEAD_NOISE)
    return bool(_NUM_DOT.match(t) or _Q_PREFIX.match(t))


def is_decorative_number(
    word: Any,
    prev_text: str = "",
) -> bool:
    """True when a number-shaped (or bullet) token is DECORATIVE / content, not an owner.

    `word` is a WordBox-like (has .text and an optional .protected flag); `prev_text` is
    the nearest real word to its left (for label context like 'Figure 3')."""
    t = (getattr(word, "text", "") or "").strip()
    if not t:
        return False
    # 1. Inside a detected figure / diagram (pixel figure detector tagged it). A label
    #    drawn inside a circuit / molecule is content, never a marker.
    if getattr(word, "protected", False):
        return True
    # 2. A circled / enclosed glyph is decorative-by-shape (it is an OPTION bullet).
    if tokens.is_circled_label(t):
        return True
    # 3. Content-number SHAPES: roman option, chemical locant '2,3-', unit '70S',
    #    ordinal '1st', decimal '1.5', range '2-3'.
    if content_number.looks_content_number(t):
        return True
    # 4. Label CONTEXT: the word to the left makes it a label ('Figure 3', 'Step 1').
    if content_number.is_label_context(prev_text):
        return True
    return False


def is_owner_boundary(word: Any, prev_text: str = "") -> bool:
    """True when a token is a REAL next-owner question marker — the only thing an active
    option search is allowed to STOP at. A decorative / badged / in-figure number returns
    False so the search continues past it (the missing options may sit just below)."""
    t = (getattr(word, "text", "") or "").strip()
    if not looks_number_marker(t):
        return False
    if is_decorative_number(word, prev_text):
        return False
    # Positive-integer floor (TS parity): a '0.' is OCR noise from a figure, not an owner.
    m = _NUM_DOT.match(t.lstrip(_LEAD_NOISE)) or _Q_PREFIX.match(t.lstrip(_LEAD_NOISE))
    try:
        return bool(m) and int(m.group(1)) >= 1
    except (TypeError, ValueError):
        return False
