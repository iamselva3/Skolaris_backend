"""Marker extraction — derive question-number markers from the WORD TOKENS TS already
OCR'd, when TS doesn't hand them over explicitly. This is token PARSING, not OCR:
Python never reads pixels, it only inspects strings TS produced.

A marker is a line-start token shaped like a question number ('12.', 'Q5', '150Match')
that is NOT an option label. Deriving markers independently (rather than trusting TS's
own segmentation) is what lets Python catch TS's split/merge mistakes.

LIMITATION (Phase 1): disambiguating DOT-style options ('1.' '2.' '3.' '4.') from a
'1.' question number needs the statistical option-vs-question classifier (Phase 2).
Papers whose options are parenthesised/lettered ('(1)' / 'a)') — the reference set
(NEET/AIOTS/Biology) — are unaffected, because those option shapes are excluded here.
TS may also pass authoritative `markers` to skip derivation entirely.
"""
from __future__ import annotations

import re
from typing import List, Sequence

from . import content_number
from .geometry import PageMetrics
from .models import Marker, WordBox

# A question number 'N<sep>' where <sep> is one of . , : ; (OCR routinely misreads the question dot as a
# comma/semicolon, and on dense/scanned pages GLUES the number to the first word). Mirrors TS NUM_DOT_RE
# (`[.:;,]`, no end-anchor). Requiring a STANDALONE 'N.' (a trailing '$') or a dot-only terminator silently
# lost whole blocks — RE NEET back pages dropped Q100-148 ('106.Read'), plus '43;' '44,' '150,'. The
# negative lookahead `(?!\d+(?![A-Za-z]))` still rejects a DECIMAL ('2.5' → dot+digits+no-letter) while
# accepting a glued WORD ('108.0bserve' → '0' is followed by letters). Dangerous content shapes (locant
# '2,3-', unit '70S', range, ordinal, decimal) are rejected by looks_content_number() BEFORE this match.
_NUM_DOT = re.compile(r"^(\d{1,3})[.,:;·](?!\d+(?![A-Za-z]))")
_Q_PREFIX = re.compile(r"^[Qq]\.?-?\s*(\d{1,3})\b")


def _strip_lead_noise(t: str) -> str:
    return t.lstrip("'\"`*•·.-—– ")


def _is_border_noise(text: str) -> bool:
    """A SCAN / FRAME-BORDER artifact, not a real word: a short token that is pure symbols (a vertical
    frame rule OCR'd as '|', '||', '—', '@', '~~') or a single letter repeated ('ll', 'oo'). On a scanned
    paper the institute box-rule sits in the left margin and OCRs as exactly these, LEFT of the question
    number — so if it counts as 'a word to the left' the real question marker is no longer a line-start and
    the question is lost. Skipping it is content-safe: a genuine 2-letter word ('is', 'in') has two
    DIFFERENT letters and is never matched. Universal — no PDF/position constant."""
    t = (text or "").strip()
    if not t or len(t) > 2:
        return False
    if not any(ch.isdigit() for ch in t):
        if not any(ch.isalpha() for ch in t):   # symbols only: | || — @ ~~ etc.
            return True
        if len(set(t.lower())) == 1:             # a single letter repeated: ll, oo, II
            return True
    return False


def _is_line_start(word: WordBox, words: Sequence[WordBox], metrics: PageMetrics) -> bool:
    cy = word.cy
    tol = metrics.line_tol
    clear = metrics.clear_left
    for w in words:
        if w is word:
            continue
        if abs(w.cy - cy) > tol:
            continue
        if _is_border_noise(w.text):
            continue  # a frame-rule / scan artifact to the left is not a real word — ignore it
        if w.x1 <= word.x0 and (word.x0 - w.x1) < clear:
            # A word in a DIFFERENT column (across the gutter) is NOT this number's left neighbour in
            # reading order — a 2-column page puts the RIGHT column's question number on the SAME physical
            # row as the LEFT column's body text, and that text often runs INTO the gutter. Judge each
            # word's column by where it STARTS (x0), not its centre: a fragment that begins in the LEFT
            # column but overflows past the gutter mid-point ('...track. If its fro') has its centre in the
            # gutter — centre-based column_of wrongly groups it with the right-column number and the
            # question is lost. x0-based keeps it in the left column, so the right-column number is still a
            # line-start. (Comparing COLUMNS, not a brittle "is a column edge between them" gap test.)
            if len(metrics.columns) >= 2 and metrics.column_of(w.x0) != metrics.column_of(word.x0):
                continue
            return False
    return True


def _left_neighbour(word: WordBox, words: Sequence[WordBox], metrics: PageMetrics) -> str:
    """Text of the nearest REAL word to the left of `word` on the same line (for label context). Frame /
    scan noise is skipped so it never becomes the label context of a question number."""
    cy = word.cy
    best = None
    best_x = -1.0
    for w in words:
        if w is word or abs(w.cy - cy) > metrics.line_tol:
            continue
        if _is_border_noise(w.text):
            continue
        if len(metrics.columns) >= 2 and metrics.column_of(w.x0) != metrics.column_of(word.x0):
            continue  # a different column's word (judged by where it starts) is not this number's context
        if w.x1 <= word.x0 and w.x1 > best_x:
            best, best_x = w, w.x1
    return best.text if best else ""


def extract_markers(words: Sequence[WordBox], metrics: PageMetrics, exclude=None) -> List[Marker]:
    """Derive question markers from word tokens. `exclude` is a set of (round(x0),round(y0))
    keys for repeated header/footer/page-number chrome — those never become question markers
    (but stay in `words` for line-start geometry; KEEP PIXELS)."""
    exclude = exclude or set()
    out: List[Marker] = []
    for w in words:
        if getattr(w, 'protected', False):
            continue  # visual_only: inside a figure/diagram — diagram labels never become question markers
        if (round(w.x0), round(w.y0)) in exclude:
            continue  # repeated chrome — never a question marker
        raw = (w.text or "").strip()
        if not raw:
            continue
        # ROBUST demotion (never promote a non-question number): reject content-number SHAPES
        # (roman option / locant / unit-glued / ordinal / decimal / range) before any match.
        if content_number.looks_content_number(raw):
            continue
        # Only line-start tokens (clear left space within the column) can open a question.
        if not _is_line_start(w, words, metrics):
            continue
        # A number whose LEFT neighbour is a figure/table/step label is a label, not a start.
        if content_number.is_label_context(_left_neighbour(w, words, metrics)):
            continue
        t = _strip_lead_noise(raw)
        num = None
        punct = "."
        # Question-number shapes: 'N.' (incl. OCR-glued 'N.word') and 'Q.N'. Dot-glued numbers are now
        # accepted (see _NUM_DOT) because the OCR routinely drops the space after the number; the dangerous
        # bare-glued shape ('150Match' / '70S' / '2,3-') is still rejected by looks_content_number() above.
        # Parenthesised '(1)' and lettered/roman options never match these.
        m = _NUM_DOT.match(t)
        if m:
            num, punct = int(m.group(1)), "."
        elif (m := _Q_PREFIX.match(t)):
            num, punct = int(m.group(1)), "Q"
        else:
            continue
        # POSITIVE-INTEGER FLOOR (TS parity, visual-segment.ts `num >= 1`): question numbers start at 1, so a
        # "0." is never a marker. This is OCR noise from inside a figure — a circuit/binary diagram reads
        # "0110 / 0. / 1110", and a phantom marker num=0 there mis-anchors its neighbours. Zero-risk.
        if num is None or num < 1:
            continue
        out.append(Marker(num=num, x0=w.x0, y0=w.y0, x1=w.x1, y1=w.y1, punct=punct))
    return out
