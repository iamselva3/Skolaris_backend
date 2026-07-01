"""Cross-page ownership (responsibility 15; merge cases 2, 3, 8).

When a question starts on page N and its remainder (text and/or options) lands at the
TOP of page N+1, page N+1 begins with ORPHAN content before its first start. If the
last question of page N ran to the page bottom, that orphan region belongs to it — do
NOT open a new question for it. Detect it and emit an Attachment to that owner.

TWO SEPARATE VALIDATORS guard this merge (do NOT merge their logic):

  Validator 1 — REAL CROSS-PAGE (Q7 pattern):
    Cross-page is TRUE only when ALL four conditions hold:
      1. Previous owner exists AND reached the page bottom OR its column bottom (layout
         continuity; column-bottom covers 2-column pages where col0 ends above col1).
      2. No standalone question-number marker inside the orphan region (the orphan
         is NOT an undetected new question whose "16." the segmenter missed).
      3. Orphan region is shallow — within the top 50% of the page (tail of a question,
         not a full set of undetected starts). ESCAPE: a pure option-label block is
         always a question tail, not undetected starts; allow up to any depth when labels
         are present, a next-question start bounds the orphan, and (if both sides are
         numbered) the numbers are consecutive.
      4. Orphan contains genuine continuation content (option labels OR substantial
         multi-word text).
    When all four hold → emit CROSS_PAGE_OPTIONS or CROSS_PAGE_CONTINUATION attachment.

  Validator 2 — FIRST-QUESTION PROTECTION (Q16 pattern):
    If the new page's FIRST numbered segment starts near the top of the page (< 20% of
    height) AND the orphan region contains NO option labels, then this page begins with
    a NEW independent question — the previous owner is terminated immediately.  Never
    inherit ownership in this situation.  Even when a header or instruction line precedes
    the new question (making the orphan "meaningful" in terms of word count), those lines
    are NOT a legitimate cross-page continuation tail.

Q7  → real cross-page: orphan = [A/B/C/D options], option labels present → Validator 2
       passes → merge fires →  CrossPage=true  PASS.
Q16 → first question on page: orphan = empty or header (no option labels) → Validator 2
       blocks → merge suppressed → CrossPage=false  PASS.

MULTI-COLUMN PAGES: For 2-column page_N, the global last-in-reading-order segment is in
col1. But when the orphan on page_N+1 is in col0 (the first start on page_N+1 is in
col0), the correct owner is col0's last segment on page_N — not col1's. Column-matched
owner lookup prevents attributing Q7(col0)'s continuation to Q_last(col1).
"""
from __future__ import annotations

import re
from typing import List, Optional, Sequence

from . import tokens
from .geometry import PageMetrics, group_lines
from .merge_types import Attachment
from .models import MergeCase, PageInput, WordBox
from .option_owner_detector import options_in_region
from .question_end_detector import Segment

# Matches a bare question-number marker word: "1.", "9)", "16.", "100)" etc.
# A word like this inside the orphan region means the segmenter missed a question start.
_QNUM_STANDALONE_RE = re.compile(r'^\d{1,3}[.)]$')

# Fraction of page height below which the first-numbered-segment is considered "near top".
_NEAR_TOP_FRAC = 0.20


def _reading_first_start(segments: List[Segment]) -> Optional[Segment]:
    if not segments:
        return None
    return min(segments, key=lambda s: (s.column, s.y0))


def _leading_orphans(page: PageInput, metrics: PageMetrics, segments: List[Segment]) -> List[WordBox]:
    """Words that precede the page's first start in reading order (column, then y)."""
    first = _reading_first_start(segments)
    if first is None:
        return list(page.words)  # a page with no start at all is all continuation
    fcol, fy = first.column, first.y0
    out: List[WordBox] = []
    for w in page.words:
        col = metrics.column_of(w.cx)
        if col < fcol or (col == fcol and w.cy < fy):
            out.append(w)
    return out


def _meaningful(words: Sequence[WordBox], metrics: PageMetrics) -> bool:
    for ln in group_lines(words, metrics.line_tol):
        if len(ln.words) >= 3:
            return True
        if ln.words and tokens.is_option_label(ln.words[0].text):
            return True
    return False


def _last_reading_segment(segments: List[Segment]) -> Optional[Segment]:
    if not segments:
        return None
    return max(segments, key=lambda s: (s.column, s.y0))


def _last_segment_in_column(segments: List[Segment], col: int) -> Optional[Segment]:
    """Last segment (by y0) in a specific column, or None if the column has no segments."""
    col_segs = [s for s in segments if s.column == col]
    if not col_segs:
        return None
    return max(col_segs, key=lambda s: s.y0)


# ─── Validator 1 helpers ─────────────────────────────────────────────────────

def _orphan_has_question_marker(orphan: List[WordBox]) -> bool:
    """Return True if ANY word in the orphan matches a standalone question-number pattern.

    A word like '16.' in the orphan means the segmenter failed to detect that start —
    the orphan is NOT a cross-page continuation tail; it is an undetected new question.
    Merging it to the previous owner would absorb Q16 into Q15.  This is Condition 2 of
    Validator 1 — 'no new question marker inside the orphan.'
    """
    for w in orphan:
        if _QNUM_STANDALONE_RE.match(w.text.strip()):
            return True
    return False


# ─── Validator 2 helper ──────────────────────────────────────────────────────

def _orphan_has_option_labels(orphan: List[WordBox]) -> bool:
    """Return True if the orphan contains at least one option label token (A), B), 1), …).

    An orphan with option labels is the TAIL of the previous question (its options flowed
    to the top of the new page — the Q7 pattern).  An orphan WITHOUT option labels is
    likely a section header, instruction, or blank region that precedes the first question
    of the new page — not a genuine continuation tail.
    """
    return any(tokens.is_option_label(w.text) for w in orphan)


# A COMPLETE MCQ option set. A question with this many option-label LINES already on the previous page is
# finished — its options did NOT spill — so a fresh option block at the top of the next page belongs to a
# DIFFERENT (unread-number) question, not to this owner. (A real spill leaves the owner with a PARTIAL set.)
_COMPLETE_OPTION_LINES = 4


def _option_line_count(words: Sequence[WordBox], metrics: PageMetrics) -> int:
    """Number of distinct lines whose first (left-most) token is an option label — i.e. how many options the
    region already carries. Line-based so a wrapped 2-line option counts once."""
    n = 0
    for ln in group_lines(words, metrics.line_tol):
        ws = sorted(ln.words, key=lambda w: w.x0)
        if ws and tokens.is_option_label(ws[0].text):
            n += 1
    return n


def detect_cross_page(
    prev_page: PageInput,
    prev_metrics: PageMetrics,
    prev_segments: List[Segment],
    page: PageInput,
    metrics: PageMetrics,
    segments: List[Segment],
) -> Optional[Attachment]:
    # ── Condition 1: previous owner exists AND reached the page/column bottom ─
    # COLUMN-AWARE OWNER: on a 2-column page the global last-in-reading-order segment
    # is in col1, but when the orphan on this page is in col0 (the first start is col0)
    # the correct owner is col0's last question on prev_page. Column-match first; fall
    # back to the global last if no same-column segment exists on prev_page.
    _first_here = _reading_first_start(segments)
    _orphan_col = _first_here.column if _first_here is not None else 0
    # MULTI-COLUMN page-by-page reading order: a continuation at col0 of page N+1 follows the READING-ORDER-
    # LAST question of page N — the RIGHTMOST column's bottom question, the one that reaches the PAGE bottom —
    # NOT the same-column (col0) last, which in a 2-column page is followed by col1 and so never spills onto
    # the next page. This is the "Assertion in col1 (bottom of page N) → Reason + options in col0 (top of
    # page N+1)" case: with the wrong owner the question keeps only its col1 part (crop = Assertion only) and
    # the continuation lands on a neighbour. Among the page-N questions that reach the PAGE bottom, take the
    # last in reading order (max column, then y). Falls back to the column-matched / single-column path when
    # nothing reaches the page bottom (e.g. col1 empty → col0's last IS the page's last).
    owner = None
    if len(prev_metrics.columns) >= 2:
        _pb = [s for s in prev_segments if s.reaches_page_bottom]
        if _pb:
            owner = max(_pb, key=lambda s: (s.column, s.y0))
    if owner is None:
        owner = _last_segment_in_column(prev_segments, _orphan_col)
        if owner is None and _orphan_col > 0:
            # No segments in the orphan column on prev_page → try lower columns in order
            for _c in range(_orphan_col - 1, -1, -1):
                owner = _last_segment_in_column(prev_segments, _c)
                if owner is not None:
                    break
        if owner is None:
            owner = _last_reading_segment(prev_segments)
    if owner is None:
        return None
    # Accept if the owner reached the PAGE bottom (ideal) OR its COLUMN bottom (multi-col
    # pages where col0 ends above col1 but the last col0 question still ran out of space).
    if not (owner.reaches_page_bottom or owner.reaches_column_bottom):
        return None

    # ── PAPER-BOUNDARY GATE ───────────────────────────────────────────────────
    # Cross-page only makes sense within ONE paper. Concatenated uploads render each
    # paper at its own DPI so consecutive pages from different papers differ in width.
    if prev_page.width and page.width:
        if abs(prev_page.width - page.width) / max(prev_page.width, page.width) > 0.02:
            return None

    # Compute the orphan region (words on the new page that precede its first start).
    orphan = _leading_orphans(page, metrics, segments)
    if not orphan or not _meaningful(orphan, metrics):
        return None

    # ── Condition 2 (Validator 1): no standalone question-number in orphan ────
    # A bare "16." or "16)" inside the orphan means the segmenter missed Q16's start.
    # Absorbing that into the previous owner would give Q15 the whole Q16 region.
    if _orphan_has_question_marker(orphan):
        return None

    # ── Condition 2b: OWNER ALREADY COMPLETE — never attach a fresh option block to a finished question ──
    # If the owner already carries a FULL option set on the previous page, it is a COMPLETE MCQ; the option
    # block at the top of the next page therefore belongs to a DIFFERENT question whose number the OCR did
    # not read (so it was never segmented), NOT to this owner. Attaching it merges two questions into one
    # crop (e.g. a 'Match List-I/List-II' MCQ followed by an assertion-reason MCQ whose '111.' was unread).
    # A GENUINE cross-page options spill leaves the owner with a PARTIAL set on the previous page — that is
    # precisely why the rest spilled — so this guard never blocks a real spill (owner option lines < full).
    # Scoped to option-bearing orphans: a wordless DIAGRAM / text continuation is unaffected.
    if _orphan_has_option_labels(orphan) and _option_line_count(owner.words, prev_metrics) >= _COMPLETE_OPTION_LINES:
        return None

    # ── Condition 3: continuation tail is SHALLOW (top 50% of the page) ──────
    # A deep orphan (> 50 %) is normally a sign of many undetected starts, not a question tail.
    # ESCAPE: a block of MCQ option labels is structurally a single question's tail — Condition 2
    # already blocked anything with a bare question-number marker, so option labels = cross-page
    # options, not undetected starts. Allow the deep merge when:
    #   • option labels are present in the orphan, AND
    #   • a next-question start is detected (so the orphan is bounded, not the entire page), AND
    #   • if BOTH sides have readable numbers, they must be consecutive (non-consecutive = suspicious).
    #   When one side has an unreadable number (garbled OCR, badged), we cannot verify consecutiveness
    #   and option labels alone are sufficient — requiring consecutive would block correct merges.
    oy1_top = max(w.y1 for w in orphan)
    if page.height and oy1_top > 0.50 * page.height:
        _has_labels = _orphan_has_option_labels(orphan)
        # _first_here already computed for owner selection above
        if _first_here is None or not _has_labels:
            # No next-start on this page (entire page is orphan) or no option labels → too risky
            return None
        _both_numbered = owner.start.num is not None and _first_here.start.num is not None
        if _both_numbered and _first_here.start.num != owner.start.num + 1:
            # Both sides have readable numbers but they are non-consecutive → suspicious; block.
            return None
        # Otherwise: option labels present + bounded orphan + (unnumbered owner OR consecutive) → allow

    # ── Validator 2: FIRST-QUESTION PROTECTION ───────────────────────────────
    # If the new page's first NUMBERED segment starts near the top of the page and the
    # orphan contains NO option labels, this page begins with a new independent owner.
    # The previous owner is terminated immediately — never inherit ownership here.
    # This is the Q16 pattern: a section header or instruction line may precede Q16
    # (making the orphan "meaningful" in word count) but those lines are not a
    # continuation tail, and Q16 should start a fresh ownership group.
    # The Q7 pattern is preserved: Q7's options ARE option labels → merge fires ✓.
    # _first_here already computed for owner selection + Condition 3 above.
    if _first_here is not None and _first_here.start.num is not None:
        top_fraction = _first_here.y0 / (page.height or 1.0)
        if top_fraction < _NEAR_TOP_FRAC and not _orphan_has_option_labels(orphan):
            return None  # first numbered question near top, no option tail — new owner

    # ── Condition 4: build the attachment ────────────────────────────────────
    col_right = metrics.columns[0].right if metrics.columns else metrics.content_x1
    opts = options_in_region(orphan, metrics, page.index, col_right)
    case = MergeCase.CROSS_PAGE_OPTIONS if opts else MergeCase.CROSS_PAGE_CONTINUATION
    conf = 0.65 + (0.15 if opts else 0.0)
    ox0 = min(w.x0 for w in orphan)
    _word_top = min(w.y0 for w in orphan)
    # extend the region UP toward the page TOP so a DIAGRAM above the first orphan WORD is captured — a
    # bond-line structure / molecule is strokes with few or no OCR words, so a word-only top would clip it
    # off (the IUPAC "name this structure" continuation, whose figure sits above the options). Use the page
    # content top, and never below a small top-band, so a wordless figure at the very top is included. The
    # crop planner's chrome band then removes any running header above it. Only for a genuine continuation.
    _top_band = 0.05 * float(page.height or 0.0)
    oy0 = min(_word_top, float(getattr(metrics, "content_y0", _word_top)), _top_band or _word_top)
    ox1 = max(w.x1 for w in orphan)
    oy1 = max(w.y1 for w in orphan)
    return Attachment(
        owner=owner,
        case=case,
        options=opts,
        region=(page.index, ox0, oy0, ox1, oy1),
        words=orphan,
        confidence=round(min(1.0, conf), 4),
        reason="page_top_leading_orphan",
    )
