"""Token-shape helpers — pure string structure, no institute/PDF specifics.

Option labels and page-role keywords are UNIVERSAL exam vocabulary (the shape of an
MCQ option, the words "answer key"), not hardcoded names or coordinates. Everything
here is a structural definition, derivable for any English exam paper.
"""
from __future__ import annotations

import os
import re
from typing import Optional

# Master switch for the SEMANTIC option families (roman / circled). Default OFF.
#
# WHY OFF BY DEFAULT: roman labels (i)(ii)(iii)(iv) are AMBIGUOUS — a genuine option family
# on a roman-option paper, but a STATEMENT enumeration inside the stem on matching / multi-
# statement questions. The reference papers (NEET/AIOTS/Biology/PHYCHE) use roman as
# sub-statements, so counting them as options OVER-COUNTS (a 4-option question reads as 6+),
# which would MASK a genuinely incomplete crop and undermine the pre-delivery validator.
# _dominant_family() (option_owner_detector) handles the easy case (drop roman when a Latin
# family is present); the unresolved case is a roman-ONLY sub-statement question. The correct
# universal enable is PAPER-LEVEL family inference (pick the document's dominant option family
# the way expected_options picks the count) — until that lands, this stays opt-in.
# Set OCR_SEMANTIC_OPTIONS=1 to enable roman/circled detection.
_SEMANTIC_OPTIONS = os.environ.get("OCR_SEMANTIC_OPTIONS", "0").strip().lower() in (
    "1", "true", "on", "yes",
)

# Option label shapes: (1) 1) (a) a) (A) A. — the leading token of an MCQ option.
# Supports the universal MCQ families: 1-5, a-e, A-E (4-option is the norm; 5-option papers
# exist; the actual count is INFERRED per document, never hardcoded).
_OPTION_LABEL_RE = re.compile(r"^[\(\[]?\s*([1-5]|[a-eA-E])\s*[\)\].:]")
# A bare parenthesised/bracketed single label, e.g. "(b)".
_OPTION_BARE_RE = re.compile(r"^[\(\[]\s*([1-5]|[a-eA-E])\s*[\)\]]$")

# ── SEMANTIC option families (universal, additive — NOT pattern-only) ──────────
# These extend the label VOCABULARY so the option detector recognises non-Latin MCQ
# styles; the *grouping/alignment/repetition* decision still lives in
# option_owner_detector (gap-start OR x-column alignment). A label shape alone is
# never an option — geometry confirms it. Each addition is end-guarded so it can
# never swallow prose (e.g. "i.e." / "v." in a sentence).
#
# Roman option label: (i) ii) (iv) v. — values i..v (covers up to 5 options). The
# negative lookahead `(?![A-Za-z])` after the terminator rejects "i.e." (the '.' is
# followed by a letter) while accepting "i. Some text" (followed by space). Anchored
# at the value so only a STANDALONE roman label matches, never a roman-prefixed word.
_OPTION_ROMAN_RE = re.compile(
    r"^[\(\[]?\s*(iv|i{1,3}|v)\s*[\)\].:](?![A-Za-z])", re.IGNORECASE
)
# Enclosed (circled / parenthesised-glyph) alphanumerics — Unicode option bullets that
# OCR preserves as a single glyph. Digits ①..⑩ ❶..❿ ⓵..⓾, letters Ⓐ..Ⓔ ⓐ..ⓔ. A circled
# glyph is unambiguous (it never appears in prose), so it needs no terminator.
_CIRCLED_DIGIT = {
    "①": "1", "②": "2", "③": "3", "④": "4", "⑤": "5",
    "⑥": "6", "⑦": "7", "⑧": "8", "⑨": "9", "⑩": "10",
    "❶": "1", "❷": "2", "❸": "3", "❹": "4", "❺": "5",
    "⓵": "1", "⓶": "2", "⓷": "3", "⓸": "4", "⓹": "5",
}
_CIRCLED_LETTER = {
    "Ⓐ": "a", "Ⓑ": "b", "Ⓒ": "c", "Ⓓ": "d", "Ⓔ": "e",
    "ⓐ": "a", "ⓑ": "b", "ⓒ": "c", "ⓓ": "d", "ⓔ": "e",
}
_CIRCLED = {**_CIRCLED_DIGIT, **_CIRCLED_LETTER}

# Boolean / True-False option words — a two-option MCQ whose "labels" are the words
# themselves. Recognised as option LABELS so a True/False question is not seen as
# zero-option (numeric) and its expected set is 2. Bare T/F single letters are NOT
# matched (too ambiguous in prose); only the full words.
_BOOLEAN = {
    "true": "true", "false": "false",
    "yes": "yes", "no": "no",
    "correct": "true", "incorrect": "false",
}

# Roman → canonical value (so distinct-label counting treats i/ii/iii/iv/v as 1..5).
_ROMAN_VALUE = {"i": "i", "ii": "ii", "iii": "iii", "iv": "iv", "v": "v"}

# Page-role keyword vocabulary (case-insensitive substring match on the page text).
_ANSWER_KEY_HINTS = (
    "answer key", "answers key", "answer keys", "key answers", "answer sheet",
    "solution key", "answer-key",
)
_CORRECTION_HINTS = (
    "correction", "corrections", "errata", "erratum", "amendment",
    "rectification", "corrigendum",
)
_APPENDIX_HINTS = (
    "appendix", "annexure", "annexe", "reference table", "formula sheet",
    "data sheet", "periodic table", "log table",
)


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _circled_value(t: str) -> Optional[str]:
    """If the token STARTS with an enclosed/circled alphanumeric, its canonical value."""
    if t and t[0] in _CIRCLED:
        return _CIRCLED[t[0]]
    return None


def is_option_label(text: str) -> bool:
    """True when a token STARTS like an MCQ option label. Covers the universal families:
    Latin '(1)'/'a)'/'B.', roman '(i)'/'ii)', circled '①'/'ⓐ', and boolean 'True'/'False'.
    Shape only — the option detector still confirms it by alignment/grouping."""
    t = (text or "").strip()
    if not t:
        return False
    if _OPTION_LABEL_RE.match(t):
        return True
    if not _SEMANTIC_OPTIONS:
        return False
    if _OPTION_ROMAN_RE.match(t):
        return True
    if _circled_value(t) is not None:
        return True
    # NOTE: boolean words (True/False) are deliberately NOT matched here — they are too
    # common in prose to gate by token shape. The validator detects a True/False question
    # with full LINE context via is_boolean_option (two aligned standalone bool lines).
    return False


def option_label_value(text: str) -> Optional[str]:
    """The canonical label key ('1'..'5' / 'a'..'e' / 'i'..'v' / 'true'/'false'), or None.
    Used for DISTINCT-label counting, so each family stays internally distinct."""
    t = (text or "").strip()
    if not t:
        return None
    m = _OPTION_LABEL_RE.match(t)
    if m:
        return m.group(1).lower()
    if not _SEMANTIC_OPTIONS:
        return None
    rm = _OPTION_ROMAN_RE.match(t)
    if rm:
        return _ROMAN_VALUE.get(rm.group(1).lower(), rm.group(1).lower())
    cv = _circled_value(t)
    if cv is not None:
        return cv
    bv = _BOOLEAN.get(normalize(t))
    if bv is not None:
        return bv
    return None


def is_bare_option_label(text: str) -> bool:
    return bool(_OPTION_BARE_RE.match((text or "").strip()))


def is_boolean_option(text: str) -> bool:
    """A True/False (yes/no) word standing in as an MCQ option label."""
    return normalize(text) in _BOOLEAN


def is_circled_label(text: str) -> bool:
    """True when a token STARTS with an enclosed/circled alphanumeric (①, ⓐ, ❶) — a
    decorative bullet glyph that is an OPTION marker, never a question owner."""
    t = (text or "").strip()
    return bool(t) and _circled_value(t) is not None


def looks_assertion_reason(page_text_lower: str) -> bool:
    """A token/line that marks an Assertion-Reason question (the STEM carries
    'Assertion'/'Reason'; the options remain the standard (1)..(4) statements). Used by
    the validator to TYPE the question, never to count options differently."""
    p = page_text_lower or ""
    return ("assertion" in p and "reason" in p) or ("(a):" in p and "(r):" in p)


def _has_any(haystack: str, needles) -> bool:
    return any(n in haystack for n in needles)


def looks_answer_key(page_text_lower: str) -> bool:
    return _has_any(page_text_lower, _ANSWER_KEY_HINTS)


def looks_correction(page_text_lower: str) -> bool:
    return _has_any(page_text_lower, _CORRECTION_HINTS)


def looks_appendix(page_text_lower: str) -> bool:
    return _has_any(page_text_lower, _APPENDIX_HINTS)


def count_answerkey_pairs(page_text_lower: str) -> int:
    """Count 'N - X' / 'N. X' answer-key pairs (a number bound to a single option
    letter/digit). A page dense with these is an answer key even without the words."""
    return len(re.findall(r"\b\d{1,3}\s*[\.\)\-:]\s*[a-dA-D1-4]\b", page_text_lower))
