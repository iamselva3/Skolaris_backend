"""Crop construction engine — Python BUILDS the crop from its OWN ownership graph.

This replaces the old "TS crops → Python validates" model. Python owns one logical
question end-to-end: it assembles every owned element (number, text, options, diagram,
continuations) across pages/columns, constructs ONE crop image, aligns + trims it, and
that crop is what gets delivered. Python never validates a TS-built crop.

Pipeline per logical question:
    ownership graph → owned regions (per page) → crop each from the page render
    → stitch in reading order → trim surrounding whitespace → PNG bytes

Pure image mechanics over Pillow. PIL is guarded so the rest of structure_engine stays
stdlib-only; crop building is invoked only when page renders are available.
"""
from __future__ import annotations

import io
from typing import Dict, List, Optional, Sequence, Tuple

try:  # Pillow is in the CV stack; absent ⇒ crop building unavailable (engine still imports).
    from PIL import Image  # type: ignore

    _PIL = True
except Exception:  # noqa: BLE001
    _PIL = False

try:
    import numpy as np  # type: ignore

    _NP = True
except Exception:  # noqa: BLE001
    _NP = False

CROP_AVAILABLE = _PIL

# (page_index, x0, y0, x1, y1) — one owned region of a question, in page-pixel coords.
Region = Tuple[int, float, float, float, float]


def _ensure_pil() -> None:
    if not _PIL:
        raise RuntimeError("Pillow unavailable — crop construction requires the CV stack")


def _load(src) -> "Image.Image":
    if hasattr(src, "crop"):  # already a PIL image
        return src
    return Image.open(io.BytesIO(src)).convert("RGB")


def regions_for_question(question: Dict, pad: float = 0.0) -> List[Region]:
    """Derive the owned regions of a question: the union bbox of all its elements PER
    (page, column) so a cross-column question yields one region per column (stitched in
    reading order), not one wide box spanning the gutter. Boxes + option refs are unioned.

    `question` is a QuestionCandidate.to_dict() (boxes[], options[])."""
    buckets: Dict[Tuple[int, int], List[float]] = {}  # (page, col-key) -> [x0,y0,x1,y1]
    elems = list(question.get("boxes", [])) + list(question.get("options", []))
    for e in elems:
        page = int(e["page"])
        # column key = quantized x0 so left/right column elements bucket separately
        col_key = int(round(float(e["x0"]) / 50.0))
        key = (page, col_key)
        x0, y0, x1, y1 = float(e["x0"]), float(e["y0"]), float(e["x1"]), float(e["y1"])
        if key not in buckets:
            buckets[key] = [x0, y0, x1, y1]
        else:
            b = buckets[key]
            b[0], b[1] = min(b[0], x0), min(b[1], y0)
            b[2], b[3] = max(b[2], x1), max(b[3], y1)
    # merge column-buckets that actually overlap in x (same visual column) on a page
    regions = _merge_same_column(buckets)
    out: List[Region] = []
    for page, x0, y0, x1, y1 in regions:
        out.append((page, x0 - pad, y0 - pad, x1 + pad, y1 + pad))
    # reading order: page, then left-to-right column, then top
    out.sort(key=lambda r: (r[0], r[1], r[2]))
    return out


def _x_overlap(a0: float, a1: float, b0: float, b1: float) -> bool:
    """True when two x-ranges overlap — i.e. they are in the same visual column."""
    return max(a0, b0) < min(a1, b1)


# (page, y, x0, x1) — a question-boundary anchor: the top of a question's own first owned box.
Anchor = Tuple[int, float, float, float]


def clamp_regions(regions: List[Region], top_anchor: Optional[Anchor], bottom_anchor: Optional[Anchor]) -> List[Region]:
    """Constrain a question's crop so it STARTS at its own number/first-box anchor and ENDS before the
    NEXT question's anchor — one question = one owner = one crop. Column-aware (clamps only apply to a
    region that shares the anchor's column, so a two-column layout keeps left/right independent):

      • top_anchor    = THIS question's topmost owned box → the crop never starts ABOVE it (so the
        previous question's trailing equation/answer/working can never leak in above the number).
      • bottom_anchor = the NEXT question's topmost owned box → the crop never reaches DOWN to/past it
        (so the next question's number/text/options can never leak in below).

    A question still owns everything between the two anchors — continuations, diagrams, options, across
    pages/columns — because the clamp is per (page, column), not a single page-end/whitespace cut."""
    if not regions:
        return regions
    out: List[Region] = []
    for (pg, x0, y0, x1, y1) in regions:
        ny0, ny1 = y0, y1
        if top_anchor is not None:
            tp, ty, tx0, tx1 = top_anchor
            if pg == tp and _x_overlap(x0, x1, tx0, tx1):
                ny0 = max(ny0, ty)
        if bottom_anchor is not None:
            bp, by, bx0, bx1 = bottom_anchor
            if pg == bp and _x_overlap(x0, x1, bx0, bx1):
                ny1 = min(ny1, by)
        if ny1 - ny0 >= 2.0:  # keep only non-degenerate regions
            out.append((pg, x0, ny0, x1, ny1))
    return out or regions  # never empty — fall back to the unclamped regions


def _merge_same_column(buckets: Dict[Tuple[int, int], List[float]]) -> List[Region]:
    by_page: Dict[int, List[List[float]]] = {}
    for (page, _ck), b in buckets.items():
        by_page.setdefault(page, []).append(list(b))
    merged: List[Region] = []
    for page, boxes in by_page.items():
        boxes.sort(key=lambda b: b[0])
        cur: List[List[float]] = []
        for b in boxes:
            if cur and b[0] <= cur[-1][2]:  # x-overlap with the running column → same column
                c = cur[-1]
                c[0], c[1] = min(c[0], b[0]), min(c[1], b[1])
                c[2], c[3] = max(c[2], b[2]), max(c[3], b[3])
            else:
                cur.append(b)
        for c in cur:
            merged.append((page, c[0], c[1], c[2], c[3]))
    return merged


def _crop(img: "Image.Image", bbox: Tuple[float, float, float, float]) -> "Image.Image":
    w, h = img.size
    x0 = max(0, int(round(bbox[0])))
    y0 = max(0, int(round(bbox[1])))
    x1 = min(w, int(round(bbox[2])))
    y1 = min(h, int(round(bbox[3])))
    if x1 <= x0 or y1 <= y0:
        return Image.new("RGB", (1, 1), "white")
    return img.crop((x0, y0, x1, y1))


def _stitch_vertical(parts: Sequence["Image.Image"], gap: int = 12) -> "Image.Image":
    parts = [p for p in parts if p.width > 0 and p.height > 0]
    if not parts:
        return Image.new("RGB", (1, 1), "white")
    width = max(p.width for p in parts)
    height = sum(p.height for p in parts) + gap * (len(parts) - 1)
    canvas = Image.new("RGB", (width, height), "white")
    y = 0
    for p in parts:
        canvas.paste(p, (0, y))  # left-align (reading order)
        y += p.height + gap
    return canvas


def _trim_whitespace(img: "Image.Image", thresh: int = 245) -> "Image.Image":
    gray = img.convert("L")
    bbox = gray.point(lambda v: 0 if v >= thresh else 255).getbbox()
    return img.crop(bbox) if bbox else img


def _erase_box(img: "Image.Image", box: Tuple[float, float, float, float], margin_frac: float = 0.18) -> "Image.Image":
    """WHITEN a rectangle (the question-number glyph) out of the crop — content-only delivery. The box
    is widened a little so the whole glyph + its trailing dot is covered, but ONLY that rectangle is
    touched: question text/options to the right and content below are left byte-identical. The number
    stays a purely internal anchor; the student never sees it in the image. Best-effort; never raises."""
    try:
        from PIL import ImageDraw  # part of the CV stack alongside Image
        x0, y0, x1, y1 = box
        mw = max(2.0, (x1 - x0)) * margin_frac
        mh = max(2.0, (y1 - y0)) * margin_frac
        X0 = max(0, int(round(x0 - mw)))
        Y0 = max(0, int(round(y0 - mh)))
        X1 = min(img.width, int(round(x1 + mw * 1.5)))  # extra on the right for the trailing dot/space
        Y1 = min(img.height, int(round(y1 + mh)))
        if X1 <= X0 or Y1 <= Y0:
            return img
        ImageDraw.Draw(img).rectangle([X0, Y0, X1 - 1, Y1 - 1], fill="white")
        return img
    except Exception:  # noqa: BLE001
        return img


def _assemble(regions: Sequence[Region], cache: Dict[int, "Image.Image"]) -> Optional["Image.Image"]:
    parts: List["Image.Image"] = []
    for page, x0, y0, x1, y1 in regions:
        img = cache.get(page)
        if img is None:
            continue
        parts.append(_crop(img, (x0, y0, x1, y1)))
    if not parts:
        return None
    return _stitch_vertical(parts)


def _pad(img: "Image.Image", frac: float, extra_top_left: float = 0.0) -> "Image.Image":
    """Add a safety margin (5–10% of the content) so the crop never hugs the content edges — never
    crop aggressively. `extra_top_left` adds ADDITIONAL margin on the TOP and LEFT only, so the
    question number (always top-left) gets extra breathing room and can never sit flush to an edge."""
    if frac <= 0 and extra_top_left <= 0:
        return img
    base = max(4, int(round(min(img.width, img.height) * max(0.0, frac))))
    extra = max(0, int(round(min(img.width, img.height) * max(0.0, extra_top_left))))
    top = left = base + extra
    bottom = right = base
    out = Image.new("RGB", (img.width + left + right, img.height + top + bottom), "white")
    out.paste(img, (left, top))
    return out


def _ensure_contains(regions: List[Region], box: "Region") -> List[Region]:
    """Expand the region that owns `box` (a number box, in the SAME page-pixel space) so the box is
    fully inside it — the GUARANTEE that the question number is never left outside the crop. Grows
    the first region on the box's page that x-overlaps it; if none exists, prepends the box as its
    own region. Only ever GROWS a region (never shrinks) — it cannot cut content."""
    if not regions:
        return [tuple(box)]
    bp, bx0, by0, bx1, by1 = box
    out = [list(r) for r in regions]
    target = None
    for r in out:
        if int(r[0]) == int(bp) and _x_overlap(r[1], r[3], bx0, bx1):
            target = r
            break
    if target is None:
        # no region shares the number's column — keep it as its own (reading order re-sorts below)
        out.insert(0, [float(bp), bx0, by0, bx1, by1])
    else:
        target[1] = min(target[1], bx0)
        target[2] = min(target[2], by0)
        target[3] = max(target[3], bx1)
        target[4] = max(target[4], by1)
    res = [tuple(r) for r in out]
    res.sort(key=lambda r: (r[0], r[1], r[2]))  # keep reading order (number region stays first)
    return res


def _number_in_crop(crop: "Image.Image", regions: List[Region], number_box: "Region") -> bool:
    """Is the locked number box visible (inked) in the assembled crop? The number lives in the first
    region (top-left in reading order), which `_assemble` pastes at canvas (0,0), so its crop-local
    box = world − region0 origin. Conservative: unknown layout (number not on region0's page) ⇒ True
    (do not invent a failure); a genuinely blank number band ⇒ False (drives repair / review)."""
    from . import crop_visibility  # local import keeps crop_engine import-light
    if crop is None or not regions:
        return True
    r0 = regions[0]
    bp, nx0, ny0, nx1, ny1 = number_box
    if int(bp) != int(r0[0]):
        return True
    local = (nx0 - r0[1], ny0 - r0[2], nx1 - r0[1], ny1 - r0[2])
    return crop_visibility.number_visible(crop, local)


def detect_edge_cuts(img: "Image.Image", thresh: int = 200, band_frac: float = 0.02,
                     ink_frac: float = 0.04) -> Dict[str, bool]:
    """Ink touching an edge band ⇒ content is cut on that side (top/bottom/left/right)."""
    if not _NP:
        return {"top": False, "bottom": False, "left": False, "right": False}
    arr = (np.asarray(img.convert("L")) < thresh)
    h, w = arr.shape
    if h < 4 or w < 4:
        return {"top": False, "bottom": False, "left": False, "right": False}
    vb = max(1, int(h * band_frac))
    hb = max(1, int(w * band_frac))
    return {
        "top": bool(arr[0:vb].mean() >= ink_frac),
        "bottom": bool(arr[h - vb:h].mean() >= ink_frac),
        "left": bool(arr[:, 0:hb].mean() >= ink_frac),
        "right": bool(arr[:, w - hb:w].mean() >= ink_frac),
    }


def _expand(regions: List[Region], edges: Dict[str, bool], step: float,
            page_sizes: Dict[int, Tuple[int, int]]) -> List[Region]:
    """Grow ownership toward each cut edge (top→first region up, bottom→last region down,
    left/right→all regions out), clamped to the page bounds."""
    if not regions:
        return regions
    regs = [list(r) for r in regions]
    first, last = regs[0], regs[-1]
    if edges.get("top"):
        first[2] = max(0.0, first[2] - step)
    if edges.get("bottom"):
        pw, ph = page_sizes.get(int(last[0]), (10 ** 6, 10 ** 6))
        last[4] = min(float(ph), last[4] + step)
    for r in regs:
        pw, ph = page_sizes.get(int(r[0]), (10 ** 6, 10 ** 6))
        if edges.get("left"):
            r[1] = max(0.0, r[1] - step)
        if edges.get("right"):
            r[3] = min(float(pw), r[3] + step)
    return [tuple(r) for r in regs]


def build_crop(
    regions: Sequence[Region],
    page_images: Dict[int, object],
    trim: bool = True,
    pad_frac: float = 0.07,
    extra_top_left: float = 0.0,
    erase_local: Optional[Tuple[float, float, float, float]] = None,
) -> Optional[bytes]:
    """Construct one crop PNG for a question from its owned regions + page renders, with a
    5–10% safety margin. Returns PNG bytes, or None. Best-effort; never raises.

    `erase_local` (a box in the ASSEMBLED-crop's own pixel space) whitens the question NUMBER out
    BEFORE trim, so the freed-up blank margin is then trimmed away and the crop starts at the content.
    The number is content-only-removed, never a visual element."""
    _ensure_pil()
    try:
        cache = {p: _load(s) for p, s in page_images.items() if s is not None}
        crop = _assemble(regions, cache)
        if crop is None:
            return None
        if erase_local is not None:
            crop = _erase_box(crop, erase_local)
        if trim:
            crop = _trim_whitespace(crop)
        crop = _pad(crop, pad_frac, extra_top_left)
        buf = io.BytesIO()
        crop.save(buf, format="PNG")
        return buf.getvalue()
    except Exception:  # noqa: BLE001
        return None


def repair_crop(
    regions: Sequence[Region],
    page_images: Dict[int, object],
    step: float,
    max_iters: int = 3,
    pad_frac: float = 0.07,
    top_anchor: Optional[Anchor] = None,
    bottom_anchor: Optional[Anchor] = None,
    number_box: Optional[Region] = None,
    remove_number: bool = True,
) -> Tuple[Optional[bytes], List[Region], Dict[str, bool]]:
    """REPAIR-FIRST crop construction: build → detect edge cuts → EXPAND ownership toward the
    cut edge → rebuild → re-validate, up to `max_iters`. Returns (png, final_regions,
    remaining_edges). Empty `remaining_edges` ⇒ a complete crop; non-empty ⇒ repair could not
    fully resolve (caller routes to review only then). Never raises.

    The crop is bounded by the question's own anchors (`top_anchor` = this question's first box,
    `bottom_anchor` = the next question's first box): the initial regions are clamped to them AND every
    expansion is re-clamped, so repair can grow toward a genuinely cut edge but can NEVER cross into the
    previous question (ink at the top is the question's OWN start, not a cut) or the next question. A
    remaining top/bottom edge after clamping is therefore the true content boundary, not a defect.

    QUESTION-NUMBER = INTERNAL ANCHOR, NOT A VISUAL ELEMENT. `number_box` (the number glyph box, same
    page-pixel space as `regions`) is used to (a) GUARANTEE the number's ROW is inside the crop so the
    same-line stem is never clipped, and (b) — when `remove_number` (default) — WHITEN the number out of
    the delivered crop so the student sees content only (the UI owns numbering). After erasure the crop
    is content-only; a final check sets `edges['number']=True` only if numbering STILL appears (removal
    failed) ⇒ the caller rejects the crop and routes to review. Never silently delivers a numbered crop."""
    _ensure_pil()
    try:
        cache = {p: _load(s) for p, s in page_images.items() if s is not None}
        sizes = {p: img.size for p, img in cache.items()}
        regs = clamp_regions([tuple(r) for r in regions], top_anchor, bottom_anchor)
        if number_box is not None:
            regs = _ensure_contains(regs, number_box)  # LOCK the number inside from the start
        edges: Dict[str, bool] = {}
        for _ in range(max(1, max_iters)):
            crop = _assemble(regs, cache)
            if crop is None:
                return None, regs, {"top": False, "bottom": False, "left": False, "right": False}
            edges = detect_edge_cuts(crop)
            # Keep the number's ROW inside the crop (so its same-line stem is never clipped). We only
            # force a top+left pull when we are NOT erasing the number — _ensure_contains already keeps
            # the box in-region, which is all the removal path needs.
            if number_box is not None and not remove_number and not _number_in_crop(crop, regs, number_box):
                edges = dict(edges)
                edges["top"] = True
                edges["left"] = True
            # A top/bottom edge that sits ON the question's anchor is the real boundary, NOT a cut to
            # repair — never expand across it into a neighbouring question.
            grown = clamp_regions(_expand(regs, edges, step, sizes), top_anchor, bottom_anchor)
            if number_box is not None:
                grown = _ensure_contains(grown, number_box)
            if not any(edges.values()) or grown == regs:  # clean, or clamped/at bounds — stop
                break
            regs = grown
        # Boundary edges are NOT cuts: ink at the TOP is the question's own number/start (every question
        # begins there), and ink at the BOTTOM that sits on the next question's anchor is the boundary
        # between questions. Suppress them so a correctly-bounded crop is not falsely rejected — only a
        # genuine LEFT/RIGHT clip (or a bottom cut NOT at the next anchor) remains a real defect.
        if top_anchor is not None:
            edges["top"] = False
        if bottom_anchor is not None and regs:
            bp, by, _bx0, _bx1 = bottom_anchor
            last = regs[-1]
            if int(last[0]) == bp and abs(float(last[4]) - by) <= max(2.0, step):
                edges["bottom"] = False
        # NUMBER LAYER — remove it (content-only) or, when removal is off, verify it is present. The
        # number lives in the first region (top-left, reading order), which `_assemble` pastes at (0,0),
        # so its crop-local box = world − region0 origin.
        erase_local: Optional[Tuple[float, float, float, float]] = None
        number_defect = False  # edges['number']: True ⇒ numbering STILL appears in the crop (a FAIL)
        if number_box is not None and regs and int(number_box[0]) == int(regs[0][0]):
            r0 = regs[0]
            nb_local = (number_box[1] - r0[1], number_box[2] - r0[2],
                        number_box[3] - r0[1], number_box[4] - r0[2])
            if remove_number:
                erase_local = nb_local
                # Verify the number is GONE on an erased copy — leftover ink in its core ⇒ removal
                # failed ⇒ flag (route to review). The student crop must never show numbering.
                from . import crop_visibility
                chk = _assemble(regs, cache)
                if chk is not None:
                    _erase_box(chk, nb_local)
                    number_defect = crop_visibility.number_present(chk, nb_local)
            else:
                number_defect = not _number_in_crop(_assemble(regs, cache), regs, number_box)
            edges["number"] = number_defect
        # final render; trim only when no real defect remains (boundary top/bottom already suppressed).
        real_defect = bool(edges.get("left") or edges.get("right") or edges.get("bottom") or number_defect)
        png = build_crop(regs, page_images, trim=not real_defect, pad_frac=pad_frac,
                         erase_local=erase_local)
        return png, regs, edges
    except Exception:  # noqa: BLE001
        return None, list(regions), {"top": False, "bottom": False, "left": False, "right": False}
