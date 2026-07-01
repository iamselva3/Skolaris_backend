"""Ownership graph — turn QuestionGroups into QuestionCandidates so that EVERY element
(question number, text, options, and — in Phase 2 — diagrams/graphs/tables/equations/
chem structures/labels/captions) receives exactly ONE owner. Elements that cannot be
confidently owned become ORPHANS routed to review. Nothing is silently dropped.

Pure assembly over the structures the detectors produced; no IO, no guessing.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from . import tokens as _tokens
from .geometry import PageMetrics
from .merge_detector import QuestionGroup
from .models import (
    Element,
    ElementKind,
    OptionRef,
    PageInput,
    QuestionCandidate,
)
from .option_owner_detector import find_option_lines, options_for_segment


def _dedup_options(opts: List[OptionRef]) -> List[OptionRef]:
    seen = set()
    out: List[OptionRef] = []
    for o in sorted(opts, key=lambda o: (o.page, o.y0, o.x0)):
        key = o.label if o.label is not None else f"_{o.page}_{round(o.y0)}"
        if key in seen:
            continue
        seen.add(key)
        out.append(o)
    return out


def build_questions(
    groups: List[QuestionGroup],
    pages: List[PageInput],
    metrics_by_page: Dict[int, PageMetrics],
    figures_by_page: Optional[Dict[int, List[Tuple[float, float, float, float]]]] = None,
) -> Tuple[List[QuestionCandidate], List[Element]]:
    figures_by_page = figures_by_page or {}
    questions: List[QuestionCandidate] = []
    owned_spans: List[Tuple[int, float, float]] = []  # (page, y0, y1) of every owned region

    for idx, g in enumerate(groups, start=1):
        prim = g.primary
        qid = f"q{prim.page}_{int(round(prim.y0))}_{idx}"

        boxes: List[Element] = []
        options: List[OptionRef] = []
        columns = set()
        pages_touched = set()

        for seg in g.all_segments:
            m = metrics_by_page[seg.page]
            boxes.append(
                Element(
                    kind=ElementKind.QUESTION_TEXT,
                    page=seg.page,
                    x0=seg.x0,
                    y0=seg.y0,
                    x1=seg.x1,
                    y1=seg.y1,
                    owner_id=qid,
                    confidence=seg.start.confidence,
                )
            )
            options.extend(options_for_segment(seg, m, figures_by_page.get(seg.page)))
            columns.add((seg.page, seg.column))
            pages_touched.add(seg.page)
            owned_spans.append((seg.page, seg.y0, seg.y1))

        for att in g.attachments:
            options.extend(att.options)
            if att.region:
                pg, ax0, ay0, ax1, ay1 = att.region
                boxes.append(
                    Element(
                        kind=ElementKind.QUESTION_TEXT,
                        page=pg,
                        x0=ax0,
                        y0=ay0,
                        x1=ax1,
                        y1=ay1,
                        owner_id=qid,
                        confidence=att.confidence,
                    )
                )
                columns.add((pg, metrics_by_page[pg].column_of((ax0 + ax1) / 2.0)))
                pages_touched.add(pg)
                owned_spans.append((pg, ay0, ay1))

        options = _dedup_options(options)

        # LOCK the question NUMBER as a first-class owned anchor: its own glyph box on the primary
        # segment. The crop layer uses it to guarantee the number is inside the crop and to validate
        # it is visible. x1 falls back to x0 + one number width so a width-less marker still yields a
        # non-degenerate band. None only when the start carries no usable geometry.
        number_box: List[float] | None = None
        if prim.start is not None:
            sx0, sy0, sy1 = prim.start.x0, prim.start.y0, prim.start.y1
            sx1 = prim.start.x1 if prim.start.x1 > sx0 else sx0 + max(1.0, (sy1 - sy0))
            number_box = [float(prim.page), float(sx0), float(sy0), float(sx1), float(sy1)]

        q = QuestionCandidate(
            id=qid,
            number=prim.start.num,
            number_confidence=prim.start.confidence,
            recovered=(getattr(prim.start, "punct", "") == "struct"),
            start_page=min(pages_touched),
            end_page=max(pages_touched),
            boxes=boxes,
            options=options,
            number_box=number_box,
            merges=list(g.cases),
            multi_column=len({c[1] for c in columns}) > 1,
            multi_page=len(pages_touched) > 1,
            multi_block=len(g.merged_segments) > 0,
            has_diagram=False,  # CV-derived in Phase 2
        )
        questions.append(q)

    # BADGE-ABSORBED RECOVERY (GAP-GUIDED — safe). When a question's number sits in a badge, no marker
    # fires, so its content is absorbed into the PREVIOUS question and its number goes MISSING (a sequence
    # gap). For each such gap, search ONLY the absorbing question's own region for a token equal to the
    # MISSING number (the badge digits, e.g. "132"); if found, split there. Gap-guided ⇒ fires only when a
    # number is genuinely missing AND its digits appear inside the over-merged region — so a clean paper
    # (no gaps) is a complete no-op and a well-formed question is never split.
    questions = _recover_badge_gaps(questions, pages, metrics_by_page)
    # CASE B — the corrupted badge number was detected as its OWN out-of-sequence question (e.g. "32"
    # between 131 and 133, where "132" lost its leading digit). Renumber it to the gap value by POSITION
    # + fuzzy digit match. Safe: only an out-of-order number that fuzzy-matches an UNFILLED enclosed gap
    # is touched; a clean ascending sequence is never changed.
    _reassign_out_of_sequence_badges(questions)
    owned_spans = [(b.page, b.y0, b.y1) for q in questions for b in q.boxes]

    orphans = _find_orphan_options(pages, metrics_by_page, owned_spans, figures_by_page)

    # BADGE / NUMBERLESS RECOVERY. A question whose number sits inside a badge (a circled "105", a
    # stylised marker) — or is otherwise unreadable — produces NO start marker, so its stem + options are
    # left UNOWNED and the question would show as "missing". But a CLUSTER of orphan OPTIONS structurally
    # PROVES a question exists there (options never float free). Recover one question per orphan option
    # BLOCK: its crop region spans from just below the previous owned content (where the stem + badge sit)
    # down through the options; its number is gap-filled from the sequence. Generic — fires ONLY when
    # options are orphaned, so a clean digital paper (no orphans) is completely unaffected.
    recovered = _recover_from_orphan_blocks(orphans, owned_spans, pages, metrics_by_page)
    if recovered:
        questions.extend(recovered)
        orphans = [o for o in orphans if o.owner_id is None]  # drop the now-claimed options
    # Gap-fill numbers for ANY numberless question (split OR recovered) from the sequence gaps.
    if any(q.number is None for q in questions):
        _gap_fill_numbers(questions, metrics_by_page)
    return questions, orphans


def _recover_badge_gaps(
    questions: List[QuestionCandidate], pages: List[PageInput], metrics_by_page: Dict[int, PageMetrics]
) -> List[QuestionCandidate]:
    """Split an over-merged question when the MISSING sequence number's digits appear inside its region
    (a badge-numbered question absorbed by the previous one). Gap-guided + token-confirmed ⇒ safe."""
    import re

    present = {q.number for q in questions if q.number is not None}
    if not present:
        return questions
    max_present = max(present)
    words_by_page: Dict[int, list] = {p.index: list(p.words) for p in pages}
    new: List[QuestionCandidate] = []
    for q in list(questions):
        if q.number is None or not q.boxes:
            continue
        gap = q.number + 1
        # Only an ENCLOSED gap is a real missing question — a present number must exist AFTER it. The
        # LAST question's N+1 is not a gap (nothing follows), so its body digits never trigger a split.
        if gap in present or gap >= max_present:
            continue
        pg = q.boxes[-1].page
        on_pg = [b for b in q.boxes if b.page == pg]
        if not on_pg:
            continue
        qy0 = min(b.y0 for b in on_pg)
        qy1 = max(b.y1 for b in on_pg)
        # Find the badge number token strictly INSIDE this question's body. The badge OFTEN corrupts the
        # number in OCR — the leading digit merges into the black circle ("132" → "32"), or a digit drops
        # ("132" → "13"). So match FUZZILY: the missing number and the token share a digit prefix OR suffix
        # (≥2 digits, so single-digit noise can't match). Gap-guided + region-bounded ⇒ only the real badge
        # in that gap matches; a clean paper never reaches here.
        from .marker_reconciler import badge_digit_match

        def _badge_match(text: str) -> bool:
            for d in re.findall(r"\d+", text or ""):
                try:
                    if badge_digit_match(int(d), gap):
                        return True
                except ValueError:
                    continue
            return False

        # The badge number that STARTS the absorbed question sits at the column's LEFT MARGIN. Restrict
        # the search to tokens there — otherwise an in-content number that merely shares digits with the
        # gap (e.g. the option value "(b) 3.0×10⁻²" matching a missing "3") is promoted to a phantom
        # question in the middle of this one's body, splitting the crop and inflating the count.
        m = metrics_by_page.get(pg)
        q_left = min(b.x0 for b in q.boxes)
        col_left = q_left
        if m and getattr(m, "columns", None):
            col_left = min((c.left for c in m.columns), key=lambda cl: abs(cl - q_left), default=q_left)
        margin_tol = max(2.0 * (getattr(m, "median_h", 0) or 18.0), 0.04 * (pages[0].width or 1000.0)) if pages else 40.0
        tok = None
        for w in words_by_page.get(pg, []):
            if qy0 + 2.0 < w.y0 < qy1 - 2.0 and _badge_match(w.text or "") and abs(w.x0 - col_left) <= margin_tol:
                if tok is None or w.y0 < tok.y0:
                    tok = w
        if tok is None:
            continue
        ty = tok.y0
        q_x0 = min(b.x0 for b in q.boxes)
        # options below the badge belong to the recovered question; above stay with the original
        below = [o for o in q.options if o.page == pg and o.y0 >= ty - 2.0]
        q.options = [o for o in q.options if not (o.page == pg and o.y0 >= ty - 2.0)]
        q.boxes = [cb for cb in (_clip_box(b, ty) for b in q.boxes) if cb is not None]
        q.end_page = q.start_page
        qid = f"badge_{pg}_{int(round(ty))}"
        box = Element(kind=ElementKind.QUESTION_TEXT, page=pg, x0=q_x0, y0=ty,
                      x1=max(b.x1 for b in on_pg), y1=qy1, owner_id=qid, confidence=0.5)
        new.append(QuestionCandidate(
            id=qid, number=gap, number_confidence=0.6, start_page=pg, end_page=pg,
            boxes=[box], options=below, needs_review=True, review_reasons=["badge_number"],
        ))
        present.add(gap)
    return questions + new


def _reassign_out_of_sequence_badges(questions: List[QuestionCandidate]) -> None:
    """Renumber a badge question whose number was OCR-corrupted and detected out of sequence. Walking in
    reading order, a number that JUMPS BACKWARD (≤ the running max) while the next expected number is an
    UNFILLED gap, and whose digits FUZZY-match that gap (corrupted leading/trailing digit), IS that gap's
    question — reassign it. A clean ascending sequence never triggers this (no backward jumps)."""
    import re

    ordered = sorted(
        [q for q in questions if q.boxes],
        key=lambda q: (q.start_page, min((b.y0 for b in q.boxes), default=0.0)),
    )
    present = {q.number for q in questions if q.number is not None}
    prev = 0
    for i, q in enumerate(ordered):
        if q.number is None:
            continue
        if q.number > prev:           # forward (in sequence or a normal skip) → advance
            prev = q.number
            continue
        expected = prev + 1           # backward jump → the badge for the missing `expected`?
        if expected in present:
            continue
        nxt = next((ordered[j].number for j in range(i + 1, len(ordered)) if ordered[j].number is not None), None)
        from .marker_reconciler import badge_digit_match

        if badge_digit_match(q.number, expected) and (nxt is None or expected < nxt):
            present.discard(q.number)
            q.number = expected
            present.add(expected)
            q.review_reasons = sorted(set((q.review_reasons or []) + ["badge_renumbered"]))
            prev = expected


def _clip_box(box: Element, max_y: float) -> Optional[Element]:
    """Return `box` with its bottom clipped to `max_y` (so a split question's stem never reaches into the
    next question's option block). None if the clip leaves it degenerate."""
    if box.y1 <= max_y:
        return box
    if max_y - box.y0 < 2.0:
        return None
    return Element(kind=box.kind, page=box.page, x0=box.x0, y0=box.y0, x1=box.x1, y1=max_y,
                   owner_id=box.owner_id, confidence=box.confidence)


def _label_value(label: Optional[str]) -> int:
    """Ordinal of an option label (a/b/c/d → 0..3, 1/2/3/4 → 0..3, i/ii/iii/iv → 0..3). -1 if unknown."""
    if not label:
        return -1
    s = label.strip().strip("().:").lower()
    if s.isdigit():
        return int(s) - 1
    if len(s) == 1 and "a" <= s <= "z":
        return ord(s) - ord("a")
    roman = {"i": 0, "ii": 1, "iii": 2, "iv": 3, "v": 4, "vi": 5}
    return roman.get(s, -1)


def _split_badge_absorbed(
    questions: List[QuestionCandidate], metrics_by_page: Dict[int, PageMetrics]
) -> List[QuestionCandidate]:
    """Split a question that ABSORBED a badge question. The robust signal is an option-label RESTART:
    one question's options run a,b,c,d (ascending, even spread over rows/columns); a SECOND question's
    options RESTART the sequence (…d, then a again). Split at each restart — the first set stays with the
    original (stem clipped above the restart), each later set becomes its own numberless question. A
    normal single question (labels only ascend) is returned UNCHANGED — so spread/2-row option layouts
    (e.g. chemical-structure options a,b / c,d) are never falsely split."""
    out: List[QuestionCandidate] = []
    for q in questions:
        opts = sorted(q.options, key=lambda o: (o.page, o.y0, o.x0))
        if len(opts) < 3:
            out.append(q)
            continue
        # split into option SETS at every label restart (next ordinal <= previous ordinal)
        sets: List[list] = [[opts[0]]]
        for o in opts[1:]:
            prev = _label_value(sets[-1][-1].label)
            cur = _label_value(o.label)
            if cur >= 0 and prev >= 0 and cur <= prev:
                sets.append([o])  # RESTART ⇒ a new question's options begin
            else:
                sets[-1].append(o)
        real = [s for s in sets if len({_label_value(op.label) for op in s if _label_value(op.label) >= 0}) >= 2]
        if len(real) < 2:
            out.append(q)
            continue
        m = metrics_by_page.get(q.start_page)
        q_x0 = min((b.x0 for b in q.boxes), default=min(o.x0 for o in real[0]))
        b1_top = min(o.y0 for o in real[1])
        q.boxes = [cb for cb in (_clip_box(b, b1_top) for b in q.boxes) if cb is not None]
        q.options = real[0]
        q.end_page = q.start_page
        out.append(q)
        prev_bottom = max(o.y1 for o in real[0])
        for s in real[1:]:
            pg = s[0].page
            bx1 = max(o.x1 for o in s)
            by0 = min(o.y0 for o in s)
            by1 = max(o.y1 for o in s)
            stem_top = max(prev_bottom, by0 - (m.median_h * 10.0 if m else 140.0))
            qid = f"split_{pg}_{int(round(by0))}"
            box = Element(kind=ElementKind.QUESTION_TEXT, page=pg, x0=q_x0, y0=stem_top, x1=bx1, y1=by1,
                          owner_id=qid, confidence=0.4)
            out.append(QuestionCandidate(
                id=qid, number=None, number_confidence=0.0, start_page=pg, end_page=pg,
                boxes=[box], options=list(s),
                needs_review=True, review_reasons=["recovered_numberless"],
            ))
            prev_bottom = by1
    return out


def _recover_from_orphan_blocks(
    orphans: List[Element],
    owned_spans: List[Tuple[int, float, float]],
    pages: List[PageInput],
    metrics_by_page: Dict[int, PageMetrics],
) -> List[QuestionCandidate]:
    """One recovered QuestionCandidate per orphan option BLOCK (number=None — gap-filled later)."""
    from collections import defaultdict

    by_page: Dict[int, List[Element]] = defaultdict(list)
    for o in orphans:
        if o.kind == ElementKind.OPTION and o.owner_id is None:
            by_page[o.page].append(o)
    owned_by_page: Dict[int, List[Tuple[float, float]]] = defaultdict(list)
    for pg, y0, y1 in owned_spans:
        owned_by_page[pg].append((y0, y1))
    words_by_page: Dict[int, list] = {p.index: list(p.words) for p in pages}

    recovered: List[QuestionCandidate] = []
    for pg, opts in by_page.items():
        m = metrics_by_page[pg]
        opts.sort(key=lambda o: (o.y0, o.x0))
        gap = max(m.median_h * 3.0, 1.0)
        blocks: List[List[Element]] = []
        cur: List[Element] = [opts[0]]
        for o in opts[1:]:
            if o.y0 - cur[-1].y1 <= gap:
                cur.append(o)
            else:
                blocks.append(cur)
                cur = [o]
        blocks.append(cur)
        for blk in blocks:
            if len(blk) < 2:  # a single stray option label is not an MCQ option block → not a question
                continue
            bx0 = min(o.x0 for o in blk)
            by0 = min(o.y0 for o in blk)
            bx1 = max(o.x1 for o in blk)
            by1 = max(o.y1 for o in blk)
            # stem_top = bottom of the nearest owned content ABOVE this block (prev question's end); the
            # stem + badge number live between there and the options. Cap to ~10 lines so a large gap
            # above can't pull in unrelated content.
            aboves = [y1 for (y0, y1) in owned_by_page.get(pg, []) if y1 <= by0 + m.line_tol]
            stem_top = max(aboves) if aboves else 0.0
            stem_top = max(stem_top, by0 - m.median_h * 10.0)
            # GUARD — a BADGE question has a real STEM (question text) in the gap between the previous
            # content and the options. A page-top / stray orphan option with NO stem above it is a
            # CROSS-PAGE CONTINUATION (its question is on the previous page), NOT a new question → leave it
            # orphan (review/merge), never invent a question. Require ≥2 NON-OPTION-LABEL stem words above
            # the options. Excluding option labels prevents orphan options A/B (above C/D) from being
            # counted as "stem" for the C/D block — that would create a false question showing only C/D.
            stem_words = [
                w for w in words_by_page.get(pg, [])
                if stem_top - m.line_tol <= w.y0 < by0 - m.line_tol
                and (w.text or "").strip()
                and not _tokens.is_option_label(w.text)
            ]
            if len(stem_words) < 2:
                continue
            qid = f"recov_{pg}_{int(round(by0))}"
            for o in blk:
                o.owner_id = qid  # claim the options off the orphan list
            box = Element(kind=ElementKind.QUESTION_TEXT, page=pg, x0=bx0, y0=stem_top, x1=bx1, y1=by1,
                          owner_id=qid, confidence=0.4)
            recovered.append(QuestionCandidate(
                id=qid, number=None, number_confidence=0.0, start_page=pg, end_page=pg,
                boxes=[box],
                options=[OptionRef(label=o.text, page=o.page, x0=o.x0, y0=o.y0, x1=o.x1, y1=o.y1) for o in blk],
                needs_review=True, review_reasons=["recovered_numberless"],
            ))
    return recovered


def _gap_fill_numbers(
    questions: List[QuestionCandidate], metrics_by_page: Dict[int, PageMetrics] | None = None
) -> None:
    """Assign sequence-gap numbers to recovered numberless questions, in reading order. A numberless
    question between detected N and N+2 gets N+1 (the badge number). Only fills an UNUSED number that
    fits strictly before the next detected number — never overwrites a detected number, never guesses
    ambiguously. Reading order is by (page, COLUMN, y) — NOT raw x — because a right-column SEAL sits in
    the gutter-side margin (x LEFT of the column's text numbers), so a raw-x sort would place it before
    the right column's numbered questions and collide its candidate with an already-used number."""
    metrics_by_page = metrics_by_page or {}

    def _key(q: QuestionCandidate):
        if q.number_box:
            pg = int(q.number_box[0]); ax = (q.number_box[1] + q.number_box[3]) / 2.0; ay = q.number_box[2]
        elif q.boxes:
            b = min(q.boxes, key=lambda bb: bb.y0); pg, ax, ay = b.page, (b.x0 + b.x1) / 2.0, b.y0
        else:
            pg, ax, ay = q.start_page, 0.0, 0.0
        m = metrics_by_page.get(pg)
        col = 0
        if m and getattr(m, "columns", None):
            try:
                col = m.column_of(ax)
            except Exception:  # noqa: BLE001
                col = 0
        return (pg, col, ay)

    ordered = sorted(questions, key=_key)
    used = {q.number for q in ordered if q.number is not None}
    prev = 0
    for i, q in enumerate(ordered):
        if q.number is not None:
            prev = q.number
            continue
        nxt = next((ordered[j].number for j in range(i + 1, len(ordered)) if ordered[j].number is not None), None)
        cand = prev + 1
        if cand not in used and (nxt is None or cand < nxt):
            q.number = cand
            used.add(cand)
            prev = cand


def _find_orphan_options(
    pages: List[PageInput],
    metrics_by_page: Dict[int, PageMetrics],
    owned_spans: List[Tuple[int, float, float]],
    figures_by_page: Optional[Dict[int, List[Tuple[float, float, float, float]]]] = None,
) -> List[Element]:
    """Option lines whose center falls in NO owned region — content nobody claimed.
    Routed to review rather than guessed onto a question."""
    figures_by_page = figures_by_page or {}
    orphans: List[Element] = []
    by_page: Dict[int, List[Tuple[float, float]]] = {}
    for pg, y0, y1 in owned_spans:
        by_page.setdefault(pg, []).append((y0, y1))

    for p in pages:
        m = metrics_by_page[p.index]
        spans = by_page.get(p.index, [])
        for ol in find_option_lines(p.words, m, figures_by_page.get(p.index)):
            cy = (ol.y0 + ol.y1) / 2.0
            inside = any(y0 - m.line_tol <= cy <= y1 + m.line_tol for y0, y1 in spans)
            if not inside:
                orphans.append(
                    Element(
                        kind=ElementKind.OPTION,
                        page=p.index,
                        x0=ol.x0,
                        y0=ol.y0,
                        x1=ol.x1,
                        y1=ol.y1,
                        text=ol.label,
                        owner_id=None,
                        confidence=0.3,
                    )
                )
    return orphans
