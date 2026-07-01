"""Marker reconciler — the heart of the Question Count Authority.

Raw line-start number tokens include FALSE question markers: content numbers, table
cells, numbered sub-items in solutions, matrix-match rows. Counting those inflates the
logical-question count. This module reconciles the raw candidates down to the CANONICAL
question markers using two document-derived structural signals (no PDF/coordinate/keyword
specifics, no estimation):

  1. MARGIN ANCHORING — real question numbers align to a small set of left-margin
     x-positions (the question column's left edge), and those margins carry an increasing
     value sequence. Candidates off those margins (table/inline numbers) are demoted.

  2. SEQUENCE RECONSTRUCTION — over the margin-anchored survivors in reading order, accept
     a candidate when it advances the sequence; a backward/duplicate value is kept ONLY if
     it begins a SUSTAINED new ascending run (a real section restart), else it is a spurious
     marker and demoted. This is section-restart-safe.

Everything derives from the document's own glyph width / marker distribution.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from statistics import median
from typing import Dict, List

from .geometry import PageMetrics
from .models import Marker, PageInput

RESTART_MIN = 4  # a backward jump is a real restart only if it begins a run of >= this many ascending values
MAX_RESTART_STEP = 4  # a restart run is CONTIGUOUS — a forward step larger than this ends the run (a sub-list that jumps back to the main sequence is not a restart)


@dataclass
class _Cand:
    page: int
    col: int
    x0: float
    y0: float
    value: int
    marker: Marker


@dataclass
class ReconcileResult:
    canonical_by_page: Dict[int, List[Marker]]
    accepted: int
    demoted_offmargin: int
    demoted_spurious: int
    duplicates: List[int] = field(default_factory=list)
    question_zero: bool = False
    restarts: int = 0
    # Missing Question Recovery: numbers recovered from demoted candidates that filled a gap,
    # and numbers still missing after recovery (each needs an explanation — never silently skipped).
    recovered: List[int] = field(default_factory=list)
    missing: List[int] = field(default_factory=list)


def _char_w(pages: List[PageInput], metrics_by_page: Dict[int, PageMetrics]) -> float:
    ws = [metrics_by_page[p.index].char_w for p in pages if metrics_by_page[p.index].char_w > 0]
    return float(median(ws)) if ws else 6.0


def _in_gutter(cx: float, columns, tol: float) -> bool:
    """True when a center-x falls in the INTER-COLUMN gutter (between one column's right edge and the
    next column's left edge, beyond a tolerance). A real question number sits at a column's LEFT edge, so a
    marker in the gutter — a diagram label, a stray inline number, OCR noise misread as 'N.' — is NOT a
    question start. Accepting it spawns a PHANTOM question that steals the previous question's figure /
    options (its crop then ends at the phantom's y, cutting the diagram off). Universal: derived from the
    page's own detected columns + glyph scale, no PDF constant."""
    for i in range(len(columns) - 1):
        if columns[i].right + tol < cx < columns[i + 1].left - tol:
            return True
    return False


def _gather(pages: List[PageInput], metrics_by_page: Dict[int, PageMetrics]) -> List[_Cand]:
    cands: List[_Cand] = []
    for p in pages:
        m = metrics_by_page[p.index]
        for mk in p.markers:
            if mk.num is None:
                continue  # numberless ("Question …") markers are not counted by value here
            col = m.column_of((mk.x0 + mk.x1) / 2.0)
            cands.append(_Cand(page=p.index, col=col, x0=mk.x0, y0=mk.y0, value=int(mk.num), marker=mk))
    cands.sort(key=lambda c: (c.page, c.col, c.y0))
    return cands


def _longest_increasing(values: List[int]) -> int:
    best = 0
    cur = 0
    prev = None
    for v in values:
        if prev is None or v > prev:
            cur += 1
        else:
            cur = 1
        best = max(best, cur)
        prev = v
    return best


def _question_margins(cands: List[_Cand], char_w: float) -> set:
    """The (col, x-bucket) keys whose markers carry an increasing sequence — the question
    columns' left margins. A bucket of table/inline numbers is not increasing, so it is
    excluded."""
    bucket = max(char_w * 2.0, 4.0)
    groups: Dict[tuple, List[_Cand]] = {}
    for c in cands:
        key = (c.col, round(c.x0 / bucket))
        groups.setdefault(key, []).append(c)
    if not groups:
        return set()
    # score each bucket by how well its values increase in reading order
    scored = []
    for key, members in groups.items():
        members.sort(key=lambda c: (c.page, c.y0))
        vals = [c.value for c in members]
        inc = _longest_increasing(vals)
        scored.append((key, len(members), inc))
    # the dominant question margin: the bucket with the longest increasing run
    top_inc = max(s[2] for s in scored)
    # keep buckets whose increasing run is a meaningful share of the dominant one and of
    # their own size (a real question margin is mostly-increasing).
    margins = set()
    for key, count, inc in scored:
        if inc >= max(3, 0.5 * top_inc) and inc >= 0.5 * count:
            margins.add(key)
    return margins


def _bucket_key(c: _Cand, char_w: float) -> tuple:
    bucket = max(char_w * 2.0, 4.0)
    return (c.col, round(c.x0 / bucket))


def reconcile_markers(
    pages: List[PageInput], metrics_by_page: Dict[int, PageMetrics]
) -> ReconcileResult:
    """Reconcile markers PER RESOLUTION GROUP, then combine. A single upload can concatenate several papers
    rendered at DIFFERENT sizes/DPIs (e.g. AIOTS 1337×1891 + DR09 3490×4936); each paper has its OWN glyph
    scale, left-margin x-positions, and number SEQUENCE (numbering restarts per paper). Reconciling them
    together made the global char_w (and thus the x-bucket size) be dominated by the LARGE-glyph paper, so
    only a couple of margin buckets survived and ~61 correctly-READ question numbers were demoted as
    'off-margin' — the real cause of the low count (122 vs ~158 read). Grouping by render size fixes that
    universally: within a group the bucketing + sequence are self-consistent. Single-resolution documents
    are one group ⇒ identical to before."""
    if not pages:
        return ReconcileResult(canonical_by_page={}, accepted=0, demoted_offmargin=0, demoted_spurious=0)
    from collections import defaultdict

    groups: Dict[tuple, List[PageInput]] = defaultdict(list)
    for p in pages:
        groups[(round(p.width), round(p.height))].append(p)
    if len(groups) <= 1:
        return _reconcile_group(pages, metrics_by_page)

    merged = ReconcileResult(canonical_by_page={}, accepted=0, demoted_offmargin=0, demoted_spurious=0)
    max_accepted_num = 0  # highest question number seen across processed groups

    for grp in groups.values():
        r = _reconcile_group(grp, metrics_by_page)

        # Multi-paper offset: when a later resolution group restarts its numbering from ~1
        # (AIOTS 1 Q1-Q90 + DR09 Q1-Q90 → detect restart, offset DR09 to Q91-Q180).
        if max_accepted_num > 0:
            grp_nums = sorted(
                m.num for ms in r.canonical_by_page.values() for m in ms if m.num is not None
            )
            if grp_nums and grp_nums[0] <= max_accepted_num * 0.5:
                # Restart detected: offset this group so it continues from max_accepted_num.
                _offset = max_accepted_num
                for ms in r.canonical_by_page.values():
                    for m in ms:
                        if m.num is not None:
                            m.num += _offset
                r.recovered = sorted(x + _offset for x in r.recovered)
                r.missing = sorted(x + _offset for x in r.missing)
                # duplicates within this group are no longer duplicates after offset
                r.duplicates = sorted(x + _offset for x in r.duplicates)

        # Update running max from this group's (possibly offset) markers.
        grp_max = max(
            (m.num for ms in r.canonical_by_page.values() for m in ms if m.num is not None),
            default=0,
        )
        if grp_max > max_accepted_num:
            max_accepted_num = grp_max

        merged.canonical_by_page.update(r.canonical_by_page)
        merged.accepted += r.accepted
        merged.demoted_offmargin += r.demoted_offmargin
        merged.demoted_spurious += r.demoted_spurious
        merged.restarts += r.restarts
        merged.duplicates = sorted(set(merged.duplicates) | set(r.duplicates))
        merged.question_zero = merged.question_zero or r.question_zero
        merged.recovered = sorted(set(merged.recovered) | set(r.recovered))
        merged.missing = sorted(set(merged.missing) | set(r.missing))
    return merged


def _reconcile_group(
    pages: List[PageInput], metrics_by_page: Dict[int, PageMetrics]
) -> ReconcileResult:
    cands = _gather(pages, metrics_by_page)
    # numberless markers ("Question …" word-markers / continuation tokens) are not counted
    # by value and must pass through UNTOUCHED — they are owned by the continuation detector.
    numberless: Dict[int, List[Marker]] = {p.index: [mk for mk in p.markers if mk.num is None] for p in pages}
    question_zero = any(c.value <= 0 for c in cands)
    if not cands:
        canonical = {p.index: list(numberless.get(p.index, [])) for p in pages}
        return ReconcileResult(canonical_by_page=canonical, accepted=0,
                               demoted_offmargin=0, demoted_spurious=0, question_zero=question_zero)

    char_w = _char_w(pages, metrics_by_page)
    margins = _question_margins(cands, char_w)

    # 1) margin anchoring — keep demoted candidates (do NOT discard) for recovery.
    on_margin: List[_Cand] = []
    demoted: List[_Cand] = []
    for c in cands:
        if not margins or _bucket_key(c, char_w) in margins:
            on_margin.append(c)
        else:
            demoted.append(c)
    demoted_offmargin = len(demoted)

    # 2) sequence reconstruction (reading order already from _gather; keep that order)
    accepted: List[_Cand] = []
    demoted_spurious = 0
    duplicates: List[int] = []
    restarts = 0
    seen_values: set = set()
    last = 0
    i = 0
    while i < len(on_margin):
        c = on_margin[i]
        v = c.value
        if v > last:
            accepted.append(c)
            seen_values.add(v)
            last = v
            i += 1
            continue
        # backward / duplicate value — restart only if a sustained ascending run starts here
        run = _run_length_from(on_margin, i)
        is_restart = v <= max(1, int(0.3 * last)) and run >= RESTART_MIN
        if is_restart:
            restarts += 1
            accepted.append(c)
            last = v
            seen_values.add(v)
            i += 1
            continue
        # A demoted backward candidate is a real DUPLICATE (flag it) only when it is an ISOLATED repeat
        # (e.g. …1,2,3,1,4,5 — the stray "1"). When it is part of a CONSECUTIVE mini-run — a numbered
        # SUB-LIST inside a solution/answer ("1." then "2." …) — it is content, NOT a duplicate question:
        # flagging it would falsely route the real Q1/Q2 to review and cascade a document-wide confidence
        # penalty (the 0.94 → REVIEW bug that zeroed PHYCHE's crops). A candidate is in a sub-list when an
        # adjacent marker is its consecutive sibling (v-1 just before, or v+1 just after).
        prev_v = on_margin[i - 1].value if i > 0 else None
        next_v = on_margin[i + 1].value if i + 1 < len(on_margin) else None
        in_sublist = next_v == v + 1 or prev_v == v - 1
        if v in seen_values and not in_sublist:
            duplicates.append(v)
        demoted.append(c)
        demoted_spurious += 1
        i += 1

    # 3) MISSING QUESTION RECOVERY — never silently skip a gap. For every missing number in the
    #    accepted contiguous range, recover the demoted candidate that fills it (out-of-order /
    #    off-margin markers, e.g. a 2nd-column question read after a higher number). Recover ONLY
    #    when the gap maps to a SINGLE demoted candidate (margin-aligned when ambiguous) so a content
    #    number can't be falsely promoted. Gaps with no candidate stay `missing` WITH an explanation.
    recovered_vals: List[int] = []
    missing: List[int] = []
    acc_vals = sorted({c.value for c in accepted if c.value > 0})
    used_demoted: set = set()
    if acc_vals:
        present = set(acc_vals)
        for g in range(acc_vals[0], acc_vals[-1] + 1):
            if g in present:
                continue
            matches = [c for c in demoted if c.value == g and id(c) not in used_demoted]
            if not matches:
                # FUZZY badge recovery — a BADGE corrupts its number in OCR (the leading digit merges into
                # the black circle: "132" → "32"). A demoted candidate whose digits are a prefix/suffix of
                # the missing number g, AND whose reading-order position sits BETWEEN the accepted g-1 and
                # g+1, IS that badge — recover + renumber it. Position-bounded ⇒ a stray "32" elsewhere
                # never matches g=132; a clean (gap-free) paper never enters this loop at all.
                prev_c = next((c for c in accepted if c.value == g - 1), None)
                next_c = next((c for c in accepted if c.value == g + 1), None)
                for c in demoted:
                    if id(c) in used_demoted:
                        continue
                    if not badge_digit_match(c.value, g):
                        continue
                    pos = (c.page, c.y0)
                    if prev_c is not None and pos < (prev_c.page, prev_c.y0):
                        continue
                    if next_c is not None and pos > (next_c.page, next_c.y0):
                        continue
                    matches.append(c)
            # A recovered marker must sit at a question-number MARGIN — even when it is the ONLY value
            # match. Otherwise an in-content number that happens to equal the missing value (e.g. the
            # option value "(b) 3.0×10⁻²" filling a missing "3") is promoted to a PHANTOM question in the
            # middle of its neighbour, splitting that crop and inflating the count. "At a margin" is by
            # DISTANCE to an already-accepted marker's left edge (<= 2 char-widths) — NOT exact bucket
            # equality: a valid number a few px off its column ("9" at x=677 vs the column's 674) must
            # still recover, while a content number (x~300, far from every margin) must not. No accepted
            # markers yet ⇒ can't discriminate, so the unique match is trusted.
            pick = None
            if matches:
                mtol = 2.0 * char_w
                acc_xs = [a.x0 for a in accepted]
                margin_matches = [c for c in matches if any(abs(c.x0 - ax) <= mtol for ax in acc_xs)] if acc_xs else matches
                if len(margin_matches) == 1:
                    pick = margin_matches[0]
            if pick is not None:
                used_demoted.add(id(pick))
                pick.value = g                       # renumber the corrupted badge to its true value
                if pick.marker is not None:
                    pick.marker.num = g
                accepted.append(pick)
                recovered_vals.append(g)
                present.add(g)
            else:
                missing.append(g)  # genuinely absent (OCR miss / numberless region) — explained, not skipped

    # build canonical markers per page: accepted (incl. recovered) + preserved numberless ones
    canonical: Dict[int, List[Marker]] = {p.index: list(numberless.get(p.index, [])) for p in pages}
    for c in accepted:
        canonical[c.page].append(c.marker)
    for p in pages:
        canonical[p.index].sort(key=lambda mk: mk.y0)

    return ReconcileResult(
        canonical_by_page=canonical,
        accepted=len(accepted),
        demoted_offmargin=demoted_offmargin,
        demoted_spurious=demoted_spurious,
        duplicates=sorted(set(duplicates)),
        question_zero=question_zero,
        restarts=restarts,
        recovered=sorted(recovered_vals),
        missing=sorted(missing),
    )


def badge_digit_match(value: int, target: int) -> bool:
    """Whether `value` is a plausibly BADGE-CORRUPTED reading of `target`.

    Badge corruption DROPS a leading digit: the printed "132" has its leading "1" absorbed into
    the black seal circle, so the OCR reads "32". The corrupted OCR read (`value`) is therefore
    STRICTLY SHORTER than the true question number (`target`). The match is never bidirectional:
    a longer `value` cannot be a corruption of a shorter `target` (that would require adding a
    digit, which badges never do). In particular badge_digit_match(117, 17) must be False —
    if it returned True, a correctly-read Q117 demoted off-margin would be renumbered to 17,
    losing Q117 and duplicating Q17. Universal + pattern-based; no PDF-specific values.
    Single-digit targets require an EXACT match (any one digit would be too loose)."""
    a, b = str(value), str(target)
    if a == b:
        return True
    # The corrupted OCR read (value=`a`) must be STRICTLY SHORTER than the true number (target=`b`).
    # Equal length → equal-length substitution (18↔19 type), not a digit drop.
    # Longer value  → value ADDED a digit, impossible for badge corruption.
    if len(b) < 2 or len(a) >= len(b):
        return False
    # a is the short/corrupted read, b is the true/longer number.
    return b.endswith(a) or b.startswith(a)


def _run_length_from(cands: List[_Cand], start: int) -> int:
    """Length of the CONTIGUOUS ascending run beginning at cands[start]. A real section restart
    increments by ~1 each step (1,2,3,4,…); a numbered SUB-LIST inside a solution/answer (e.g. "1.
    … 2. …") that then jumps back to the main sequence (…,2,→36) is NOT a sustained restart. So the
    run continues only on a SMALL forward step and ENDS on a large forward jump (or equal/backward).
    This stops a 2-item solution sub-list from being promoted to a section restart (phantom 1,2)."""
    run = 1
    prev = cands[start].value
    j = start + 1
    while j < len(cands):
        v = cands[j].value
        if v > prev and (v - prev) <= MAX_RESTART_STEP:
            run += 1
            prev = v
            j += 1
        else:
            break
    return run
