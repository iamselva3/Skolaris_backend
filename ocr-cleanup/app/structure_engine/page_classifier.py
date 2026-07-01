"""Page classifier — assign each page a structural ROLE so TS can ignore non-question
pages (answer keys, correction lists, appendices, blanks) instead of mining them for
questions. Keyword vocabulary is universal exam structure, never institute-specific;
density signals derive from the page's own line count.

Responsibilities covered: 16 correction-list, 17 answer-key, 18 appendix, 19 ignore.
"""
from __future__ import annotations

from typing import List

from . import tokens
from .geometry import PageMetrics
from .models import PageClass, PageInput, PageKind

# SEMANTIC page roles — Python only ever proposes these (TS decides). Their confidence
# is hard-capped below the auto-accept floor (constraint: a semantic label can NEVER be
# auto-accepted, and confidence < 100 always).
_SEMANTIC_KINDS = {PageKind.ANSWER_KEY, PageKind.CORRECTION, PageKind.APPENDIX}
SEMANTIC_LABEL_MAX = 0.94  # strictly below the 95 auto-accept tier


def _semantic(index: int, kind: PageKind, confidence: float, reason: str) -> PageClass:
    """A semantic CANDIDATE page role — capped sub-auto-accept, flagged candidate=True."""
    return PageClass(index, kind, min(confidence, SEMANTIC_LABEL_MAX), f"{reason} (candidate)", candidate=True)


def classify_page(page: PageInput, metrics: PageMetrics) -> PageClass:
    words = page.words
    n_lines = max(1, len(metrics.lines))
    page_text = tokens.normalize(" ".join(w.text for w in words))

    # IGNORE: structurally empty (blank / separator / pure-image page with no tokens).
    if len(words) <= 3 or len(page_text) < 8:
        return PageClass(page.index, PageKind.IGNORE, 0.9, "empty_or_imageonly")

    # ANSWER KEY: explicit words, OR a grid with MANY answer pairs PER LINE. A real
    # question page lists options as separate lines (≈1 'N x' pair per line at most); an
    # answer key packs several pairs per line ("1. a  2. b  3. c …"). Using pairs-per-line
    # (not raw count or marker count) avoids mistaking normal MCQ options for a key.
    # A keyword-based semantic role (answer-key / correction / appendix) is a QUESTION page when it
    # carries a real set of question-number markers — a stray keyword (a word inside a question, or OCR
    # noise from the header/watermark) must NEVER drop a whole page of questions. So EVERY keyword check is
    # gated by a LOW marker count: a genuine answer-key / correction / appendix page has at most a couple
    # of line-start numbers, not a full column of question numbers. (Universal: derived from the page's own
    # marker/line counts, no PDF/keyword-specific exception.) The answer-PAIR-density key has no question
    # markers by nature (it is "1 a 2 b 3 c …"), so it keeps its own structural test.
    semantic_marker_cap = max(2, int(0.1 * n_lines))
    few_markers = len(page.markers) <= semantic_marker_cap
    pairs = tokens.count_answerkey_pairs(page_text)
    if tokens.looks_answer_key(page_text) and few_markers:
        return _semantic(page.index, PageKind.ANSWER_KEY, 0.92, "answer_key_keyword")
    if pairs >= max(8, 2 * n_lines):
        return _semantic(page.index, PageKind.ANSWER_KEY, 0.78, f"answer_pair_density:{pairs}/{n_lines}")

    if tokens.looks_correction(page_text) and few_markers:
        return _semantic(page.index, PageKind.CORRECTION, 0.82, "correction_keyword")

    if tokens.looks_appendix(page_text) and few_markers:
        return _semantic(page.index, PageKind.APPENDIX, 0.75, "appendix_keyword")

    # Default: a question page. Confidence scales with how many question markers it has.
    conf = 0.6 + min(0.35, 0.05 * len(page.markers))
    return PageClass(page.index, PageKind.QUESTION, round(conf, 4), f"markers:{len(page.markers)}")


def classify_pages(pages: List[PageInput], metrics_by_page) -> List[PageClass]:
    return [classify_page(p, metrics_by_page[p.index]) for p in pages]
