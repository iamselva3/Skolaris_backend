"""Document-level repeated-region detector — header / footer / page-number chrome.

A real paper repeats an institute header, a footer, and a page number on most pages. If a
repeated chrome token starts with a number ("10. NEET 2026", a numbered footer), it would
otherwise become a FALSE question marker on every page. This detector finds tokens that
repeat at the SAME edge position across MANY pages and marks them as chrome so they are
excluded from question-marker derivation and option search.

Conservative, KEEP-PIXELS first:
  • only the top (<12%) and bottom (>88%) bands — never the body;
  • only when repeated on a large share of pages (≥60%, and ≥3 pages);
  • page numbers (a number at a stable edge position whose VALUE changes per page) count as
    repeated chrome too.
It never deletes pixels and never touches body content — it only stops chrome from being
mistaken for a question. Single-page / short docs ⇒ no removal (returns empty).

Token-only (watermarks / divider lines have no tokens — those stay with the cleanup engine,
KEEP PIXELS). Pure, no IO.
"""
from __future__ import annotations

import re
from collections import defaultdict
from typing import Dict, List, Set, Tuple

from .models import PageInput

_TOP = 0.12
_BOTTOM = 0.88
_MIN_PAGES = 3
_SHARE = 0.6


def _norm(t: str) -> str:
    return re.sub(r"\s+", "", (t or "").strip().lower())


def detect_chrome(pages: List[PageInput]) -> Dict[int, Set[Tuple[int, int]]]:
    """Return per-page chrome word keys {(round(x0), round(y0))} to exclude from markers/options."""
    n = len(pages)
    if n < _MIN_PAGES:
        return {}

    sig_pages: Dict[tuple, Set[int]] = defaultdict(set)
    sig_words: Dict[tuple, List[Tuple[int, Tuple[int, int]]]] = defaultdict(list)
    for p in pages:
        h = p.height or max((w.y1 for w in p.words), default=1.0) or 1.0
        for w in p.words:
            yr = w.y0 / h
            if yr < _TOP:
                band = "T"
            elif yr > _BOTTOM:
                band = "B"
            else:
                continue
            txt = _norm(w.text)
            if not txt:
                continue
            # position signature: a number is keyed as <num> so a per-page-incrementing page
            # number still matches across pages (same edge slot, changing value).
            label = "<num>" if txt.isdigit() else txt
            sig = (label, band, round(w.x0 / 30.0))
            sig_pages[sig].add(p.index)
            sig_words[sig].append((p.index, (round(w.x0), round(w.y0))))

    threshold = max(_MIN_PAGES, int(_SHARE * n))
    chrome: Dict[int, Set[Tuple[int, int]]] = defaultdict(set)
    for sig, pgs in sig_pages.items():
        if len(pgs) >= threshold:  # repeated across MANY pages ⇒ chrome
            for pi, key in sig_words[sig]:
                chrome[pi].add(key)
    return dict(chrome)


def chrome_bands(pages: List[PageInput], chrome: Dict[int, Set[Tuple[int, int]]]) -> Dict[int, Tuple[float, float]]:
    """Per-page (header_bottom_y, footer_top_y) — the y-extent of the repeated header/footer chrome, so a
    crop can be CLIPPED to (header_bottom, footer_top) and the repeated institute header/footer (e.g. the
    'SK LEARNINGS' banner) never appears in a question crop. CONTENT-SAFE: derived ONLY from the top
    (<12%) / bottom (>88%) repeated-chrome tokens, never the body — `header_bottom` is the lowest edge of
    the top-band chrome, `footer_top` the highest edge of the bottom-band chrome. No chrome ⇒ no clip."""
    bands: Dict[int, Tuple[float, float]] = {}
    for p in pages:
        keys = chrome.get(p.index)
        if not keys:
            continue
        h = p.height or max((w.y1 for w in p.words), default=1.0) or 1.0
        header_bottom = 0.0
        footer_top = float(h)
        for w in p.words:
            if (round(w.x0), round(w.y0)) not in keys:
                continue
            yr = w.y0 / h
            if yr < _TOP:
                header_bottom = max(header_bottom, float(w.y1))
            elif yr > _BOTTOM:
                footer_top = min(footer_top, float(w.y0))
        if header_bottom > 0.0 or footer_top < float(h):
            bands[p.index] = (header_bottom, footer_top)
    return bands
