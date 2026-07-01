"""Document cleanup core — content-SAFE, OBJECT-LEVEL background-artifact removal.

CONTRACT:
  clean_document(content, mime, owner) -> (bytes, changed)      # used by the service
  analyze(content, mime)              -> (bytes, changed, report)# used by validate.py

NO OCR. NO AI. Pure CV (PyMuPDF + OpenCV + NumPy). Decisions are made per WHOLE
OBJECT (connected component) using MULTIPLE signals together — never per pixel —
so an artifact is removed WHOLE or kept WHOLE (no trails, no fragments):

  signals = geometry + structural isolation (whitespace all around) +
            object continuity + NO content intersection + repetition across pages

Default for every ink component is CONTENT (protected, dilated to guard edges /
sub-superscripts / punctuation). A component is reclassified as a removable
ARTIFACT only when a category test passes with ALL its signals:

  divider/border : long + thin + near-continuous + whitespace on BOTH sides + no
                   content intersection (a graph axis / table border / figure edge
                   has content beside it → KEPT)
  border (frame) : bbox ~= whole page + hollow (pixels on the perimeter) + isolated
  header/footer  : thin band component inked on the MAJORITY of pages at the same
                   edge rows (running header/footer), gap-separated from the body —
                   NO top/bottom-% assumption
  logo           : dense block repeated at the same normalised position across the
                   MAJORITY of pages, isolated, not on a single page (a diagram
                   appears once → KEPT)
  speck/noise    : tiny AND no other ink within reach (punctuation has neighbours)

Cleanup then lifts every NON-protected pixel to the page's own paper colour: this
removes the diffuse background / watermark / grey / faded shadow in empty areas AND
clears each artifact object whole. A watermark over content is protected → kept
whole. VALIDATION before returning: protected pixels must be byte-identical and the
page must keep the vast majority of its ink, else the ORIGINAL bytes are returned.

No env tunables (no BACKGROUND_THRESHOLD / HEADER_HEIGHT / DIVIDER_X /
WATERMARK_ALPHA / NOISE_LEVEL). The few constants are STRUCTURAL DEFINITIONS,
relative to the document. No-op unless CLEANUP_ENGINE=cv.
"""
from __future__ import annotations

import logging
import time

from .config import settings

log = logging.getLogger("ocr-cleanup.engine")

# ── Structural definitions (relative/dynamic; NOT env knobs, NOT per-paper) ──
_LINE_LEN_FRAC = 0.5      # a rule spans >= half the page in its long axis
_LINE_THIN_FRAC = 0.012   # ...and is <= ~1% of the page in its short axis
_LINE_FILL = 0.6          # ...and its bbox is >= 60% inked (near-continuous)
_BORDER_SPAN = 0.8        # a page-border frame's bbox covers >= 80% of each axis
_BORDER_PERIM = 0.85      # ...with >= 85% of its ink on the bbox perimeter (hollow)
_SPECK_FRAC = 0.15        # a speck is < 15% of the median glyph area
_BAND_MAJORITY = 0.6      # a running header/footer inks >= 60% of pages at a row
_HF_MAX_HEIGHT = 2.5      # a header/footer component is <= 2.5x the median glyph height
_LOGO_MIN_AREA = 12.0     # a logo block is >= 12x the median glyph area
_LOGO_MATCH_IOU = 0.5     # repeated-object match across pages (normalised bbox IoU)
_KEEP_INK_RATIO = 0.85    # regression guard: keep >= 85% of ink, else return ORIGINAL


def clean_document(content: bytes, mime: str, owner: str) -> tuple[bytes, bool]:
    if settings.engine != "cv":
        return content, False
    try:
        data, changed, _ = analyze(content, mime)
        return data, changed
    except Exception:  # noqa: BLE001 — any failure degrades to the original.
        log.exception("cleanup failed — returning ORIGINAL bytes")
        return content, False


def analyze(content: bytes, mime: str) -> tuple[bytes, bool, dict]:
    m = (mime or "").lower()
    if "pdf" in m:
        return _clean_pdf(content)
    if m.startswith("image/"):
        return _clean_image(content)
    return content, False, _empty_report(0)


def _empty_report(pages: int) -> dict:
    return {
        "pages": pages, "validated_pages": 0, "changed": False,
        "content_damage_px": 0, "min_ink_retention": 1.0,
        "background_px": 0, "watermark_px": 0,
        "divider_objects": 0, "divider_px": 0,
        "border_objects": 0, "border_px": 0,
        "header_objects": 0, "header_px": 0,
        "footer_objects": 0, "footer_px": 0,
        "logo_objects": 0, "logo_px": 0,
        "speck_objects": 0, "speck_px": 0,
    }


def _merge(acc: dict, page: dict) -> None:
    for k in ("background_px", "watermark_px", "divider_objects", "divider_px",
              "border_objects", "border_px", "header_objects", "header_px",
              "footer_objects", "footer_px",
              "logo_objects", "logo_px", "speck_objects", "speck_px", "content_damage_px"):
        acc[k] += page.get(k, 0)
    acc["min_ink_retention"] = min(acc["min_ink_retention"], page.get("ink_retention", 1.0))
    if page.get("validated"):
        acc["validated_pages"] += 1


# ─────────────────────────── entry points ───────────────────────────

def _native_dpi(page) -> int:
    # Cap the working resolution so memory/time stay bounded. Render + CV + encode
    # all scale with pixel count, and the downstream OCR engine consumes ~144 DPI
    # effective, so working above settings.work_dpi (default 150) only costs time.
    page_in = (max(page.rect.width, page.rect.height) / 72.0) or 11.0
    cap_dpi = min(float(settings.work_dpi), 2200.0 / page_in)
    try:
        maxpx = 0
        for im in page.get_images(full=True):
            d = page.parent.extract_image(im[0])
            maxpx = max(maxpx, d.get("width", 0), d.get("height", 0))
        if maxpx:
            return int(max(120, min(cap_dpi, maxpx / page_in)))
    except Exception:  # noqa: BLE001
        pass
    return int(max(120, min(cap_dpi, 200.0)))


def _clean_pdf(content: bytes) -> tuple[bytes, bool, dict]:
    import fitz
    import numpy as np
    import cv2

    doc = fitz.open(stream=content, filetype="pdf")
    try:
        # Wall-clock budget — bail to the ORIGINAL bytes if the whole pass can't
        # finish in time, so Python never burns CPU after the Node client has
        # aborted (golden rule: never burn for zero output).
        budget = time.perf_counter() + settings.max_ms / 1000.0
        # [cleanup-timing] this pass runs in the BACKGROUND (off the OCR critical
        # path). Time the render / detect / clean+rebuild stages separately so the
        # bottleneck is visible in logs.
        t_render = time.perf_counter()
        rects, imgs, grays = [], [], []
        for page in doc:
            if time.perf_counter() > budget:
                log.warning(
                    "[cleanup-timing] budget_exceeded during render at page %d/%d (max_ms=%d) "
                    "— returning ORIGINAL bytes",
                    len(imgs), doc.page_count, settings.max_ms,
                )
                return content, False, _empty_report(doc.page_count)
            pix = page.get_pixmap(dpi=_native_dpi(page), colorspace=fitz.csRGB, alpha=False)
            img = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, 3).copy()
            rects.append(page.rect)
            imgs.append(img)
            grays.append(cv2.cvtColor(img, cv2.COLOR_RGB2GRAY))
        render_ms = (time.perf_counter() - t_render) * 1000.0

        t_detect = time.perf_counter()
        bands = _detect_repeated_bands(grays, np, cv2)
        logos = _detect_repeated_logos(grays, np, cv2)
        detect_ms = (time.perf_counter() - t_detect) * 1000.0

        t_clean = time.perf_counter()
        report = _empty_report(len(imgs))
        out = fitz.open()
        any_changed = False
        for page_idx, (rect, img, gray) in enumerate(zip(rects, imgs, grays)):
            if time.perf_counter() > budget:
                out.close()
                log.warning(
                    "[cleanup-timing] budget_exceeded after %d/%d page(s) (max_ms=%d) "
                    "— returning ORIGINAL bytes",
                    page_idx, len(imgs), settings.max_ms,
                )
                return content, False, report
            cleaned, changed, pr = _clean_page(img, gray, np, cv2, bands, logos)
            _merge(report, pr)
            any_changed = any_changed or changed
            use = cleaned if changed else img
            ok, buf = cv2.imencode(".png", cv2.cvtColor(use, cv2.COLOR_RGB2BGR))
            if not ok:
                raise RuntimeError("png encode failed")
            newp = out.new_page(width=rect.width, height=rect.height)
            newp.insert_image(newp.rect, stream=buf.tobytes())
        clean_ms = (time.perf_counter() - t_clean) * 1000.0

        report["changed"] = any_changed
        log.info(
            "[cleanup-timing] pages=%d in_bytes=%d render_ms=%.0f detect_ms=%.0f "
            "clean_rebuild_ms=%.0f changed=%s",
            len(imgs), len(content), render_ms, detect_ms, clean_ms, any_changed,
        )
        if not any_changed:
            out.close()
            return content, False, report
        t_enc = time.perf_counter()
        data = out.tobytes(deflate=True, garbage=3)
        out.close()
        log.info(
            "[cleanup-timing] serialize_ms=%.0f out_bytes=%d (delta=%+d)",
            (time.perf_counter() - t_enc) * 1000.0, len(data), len(data) - len(content),
        )
        return data, True, report
    finally:
        doc.close()


def _clean_image(content: bytes) -> tuple[bytes, bool, dict]:
    import numpy as np
    import cv2

    arr = cv2.imdecode(np.frombuffer(content, np.uint8), cv2.IMREAD_COLOR)
    if arr is None:
        return content, False, _empty_report(0)
    rgb = cv2.cvtColor(arr, cv2.COLOR_BGR2RGB)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    report = _empty_report(1)
    cleaned, changed, pr = _clean_page(rgb, gray, np, cv2, bands=[], logos=[])
    _merge(report, pr)
    report["changed"] = changed
    if not changed:
        return content, False, report
    ok, buf = cv2.imencode(".png", cv2.cvtColor(cleaned, cv2.COLOR_RGB2BGR))
    if not ok:
        return content, False, report
    return buf.tobytes(), True, report


# ─────────────────────────── signals ───────────────────────────

def _otsu_ink(gray, cv2):
    g = cv2.GaussianBlur(gray, (3, 3), 0)
    _, ink = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    return ink


def _paper_color(img, ink, np):
    bg = img[ink == 0]
    if bg.size == 0:
        return np.array([255, 255, 255], np.uint8)
    return np.percentile(bg.reshape(-1, 3), 75, axis=0).astype(np.uint8)


def _is_line(bw, bh, area, W, H) -> bool:
    long_v = bh >= _LINE_LEN_FRAC * H and bw <= max(3, _LINE_THIN_FRAC * W)
    long_h = bw >= _LINE_LEN_FRAC * W and bh <= max(3, _LINE_THIN_FRAC * H)
    if not (long_v or long_h):
        return False
    return area / max(1, bw * bh) >= _LINE_FILL


def _isolated_sides(x, y, bw, bh, ink, np, margin) -> bool:
    H, W = ink.shape
    if bh >= bw:
        left = ink[y:y + bh, max(0, x - margin):x]
        right = ink[y:y + bh, x + bw:min(W, x + bw + margin)]
        return float(left.mean() if left.size else 0) < 2 and float(right.mean() if right.size else 0) < 2
    top = ink[max(0, y - margin):y, x:x + bw]
    bot = ink[y + bh:min(H, y + bh + margin), x:x + bw]
    return float(top.mean() if top.size else 0) < 2 and float(bot.mean() if bot.size else 0) < 2


def _is_border_frame(comp_roi, bw, bh, area, W, H, np) -> bool:
    # comp_roi is the component mask cropped to its OWN bbox (shape bh×bw), so the
    # perimeter test is computed locally instead of allocating a full-page array.
    if not (bw >= _BORDER_SPAN * W and bh >= _BORDER_SPAN * H):
        return False
    # Hollow: almost all of the component's pixels sit on the bbox perimeter.
    inner = np.zeros((bh, bw), np.bool_)
    pad = max(2, int(0.02 * min(bw, bh)))
    inner[pad:bh - pad, pad:bw - pad] = True
    perim_px = int(np.count_nonzero(comp_roi & ~inner))
    return area > 0 and perim_px / area >= _BORDER_PERIM


def _band_tag(y0, y1, bands):
    for (b0, b1, tag) in bands:
        if y0 >= b0 and y1 <= b1:
            return tag
    return None


def _norm_box(x, y, bw, bh, W, H):
    return (x / W, y / H, (x + bw) / W, (y + bh) / H)


def _iou(a, b) -> float:
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, ix1 - ix0), max(0.0, iy1 - iy0)
    inter = iw * ih
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def _matches_logo(nbox, logos) -> bool:
    return any(_iou(nbox, lb) >= _LOGO_MATCH_IOU for lb in logos)


# ─────────────────────────── per-page cleanup ───────────────────────────

def _clean_page(img, gray, np, cv2, bands, logos):
    H, W = gray.shape
    pr = {"validated": False, "ink_retention": 1.0}
    ink = _otsu_ink(gray, cv2)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    if n <= 1:
        return img, False, pr

    paper = _paper_color(img, ink, np)
    areas = stats[1:, cv2.CC_STAT_AREA]
    heights = stats[1:, cv2.CC_STAT_HEIGHT]
    med_area = float(np.median(areas)) if areas.size else 0.0
    med_h = float(np.median(heights)) if heights.size else 8.0
    radius = max(3, int(round(med_h)))
    ink_neighbours = cv2.dilate(ink, np.ones((radius, radius), np.uint8))

    protect = np.zeros((H, W), np.uint8)
    counts = {"divider": [0, 0], "border": [0, 0], "header": [0, 0],
              "footer": [0, 0], "logo": [0, 0], "speck": [0, 0]}  # [objects, pixels]

    # PERF: every per-component test below works on the component's OWN bbox
    # sub-array (comp_roi), never `labels == i` over the whole page. A text-dense
    # scan has thousands of components, so a full-page mask per component was
    # O(components × H × W) — the ~10.7s/page hotspot. The decisions are identical;
    # only the working region shrinks from the page to each glyph's bbox.
    speck_cap = max(4, _SPECK_FRAC * med_area) if med_area else 0
    logo_min = max(_LOGO_MIN_AREA * med_area, 1)
    for i in range(1, n):
        x = int(stats[i, cv2.CC_STAT_LEFT]); y = int(stats[i, cv2.CC_STAT_TOP])
        bw = int(stats[i, cv2.CC_STAT_WIDTH]); bh = int(stats[i, cv2.CC_STAT_HEIGHT])
        area = int(stats[i, cv2.CC_STAT_AREA])
        roi = labels[y:y + bh, x:x + bw]
        comp_roi = roi == i

        cat = None
        # border frame (only huge components qualify; comp_roi is bbox-local)
        if _is_border_frame(comp_roi, bw, bh, area, W, H, np):
            cat = "border"
        # divider / rule line
        elif _is_line(bw, bh, area, W, H) and _isolated_sides(x, y, bw, bh, ink, np, radius):
            cat = "divider"
        # repeated logo block (across pages, same normalised position)
        elif logos and area >= logo_min and \
                _matches_logo(_norm_box(x, y, bw, bh, W, H), logos) and \
                _isolated_sides(x, y, bw, bh, ink, np, radius):
            cat = "logo"
        # running header / footer: thin component inside a repeated edge band
        elif bands and bh <= _HF_MAX_HEIGHT * med_h and _band_tag(y, y + bh, bands):
            cat = _band_tag(y, y + bh, bands)
        # isolated speck / dust (punctuation has neighbours, so it is never a speck).
        # Evaluated on a local window expanded by 2*radius — the only region that
        # can affect the original full-page dilate-overlap test — instead of two
        # full-page copies per speck.
        elif speck_cap and area < speck_cap:
            ry0 = max(0, y - 2 * radius); ry1 = min(H, y + bh + 2 * radius)
            rx0 = max(0, x - 2 * radius); rx1 = min(W, x + bw + 2 * radius)
            comp_win = labels[ry0:ry1, rx0:rx1] == i
            other = ink_neighbours[ry0:ry1, rx0:rx1].copy(); other[comp_win] = 0
            cdil = cv2.dilate(comp_win.astype(np.uint8) * 255, np.ones((radius, radius), np.uint8))
            if not np.any((cdil > 0) & (other > 0)):
                cat = "speck"

        if cat is None:
            protect[y:y + bh, x:x + bw][comp_roi] = 255
        else:
            counts[cat][0] += 1
            counts[cat][1] += area

    # Protection wins everywhere it reaches (dilated) — anything near content is kept
    # WHOLE; isolated artifacts sit outside this shadow and are cleared WHOLE.
    grow = max(2, radius // 2)
    protect = cv2.dilate(protect, np.ones((grow, grow), np.uint8))

    cleaned = img.copy()
    bg_mask = protect == 0
    cleaned[bg_mask] = paper

    # ── instrument: split the diffuse fill into background vs watermark/shadow ──
    paper_lum = float(np.mean(paper))
    gray_changed = bg_mask & (ink == 0)  # non-ink pixels we whitened
    if np.any(gray_changed):
        vals = gray[gray_changed].astype(np.float32)
        near_paper = vals >= (paper_lum - 18)   # ~paper = background
        pr["background_px"] = int(np.count_nonzero(near_paper))
        pr["watermark_px"] = int(gray_changed.sum() - pr["background_px"])  # mid-grey = watermark/shadow
    for k, (o, p) in counts.items():
        pr[f"{k}_objects"] = o
        pr[f"{k}_px"] = p

    # ── validation gate: content pixels byte-identical + ink retention high ──
    p = protect > 0
    pr["content_damage_px"] = int(np.count_nonzero(np.any(cleaned[p] != img[p], axis=-1))) if np.any(p) else 0
    orig_ink = int(np.count_nonzero(ink))
    kept_ink = int(np.count_nonzero((ink > 0) & p))
    pr["ink_retention"] = (kept_ink / orig_ink) if orig_ink else 0.0

    if pr["content_damage_px"] != 0 or orig_ink == 0 or pr["ink_retention"] < _KEEP_INK_RATIO:
        return img, False, pr  # KEEP ORIGINAL
    pr["validated"] = True
    changed = bool(np.any(cleaned != img))
    return (cleaned, True, pr) if changed else (img, False, pr)


# ─────────────────────── cross-page header/footer ───────────────────────

def _edge_band(rep, from_top: bool):
    Hn = rep.shape[0]
    idx = range(Hn) if from_top else range(Hn - 1, -1, -1)
    start = end = None
    seen = False
    for r in idx:
        if rep[r]:
            if start is None:
                start = r
            end = r
            seen = True
        elif seen:
            break
    if start is None:
        return None
    y0, y1 = (start, end + 1) if from_top else (end, start + 1)
    if (y1 - y0) >= 0.4 * Hn:
        return None
    return (int(y0), int(y1))


def _detect_repeated_bands(grays, np, cv2):
    if len(grays) < 2:
        return []
    Hn = min(g.shape[0] for g in grays)
    if Hn <= 0:
        return []
    profs = []
    for g in grays:
        ink = _otsu_ink(g, cv2)[:Hn]
        rows = (ink.sum(axis=1) > (0.002 * ink.shape[1] * 255)).astype(np.uint8)
        profs.append(rows)
    rep = np.stack(profs).mean(axis=0) >= _BAND_MAJORITY
    out = []
    top = _edge_band(rep, True)
    bot = _edge_band(rep, False)
    if top:
        out.append((top[0], top[1], "header"))
    if bot:
        out.append((bot[0], bot[1], "footer"))
    return out


# ─────────────────────── cross-page repeated logos ───────────────────────

def _detect_repeated_logos(grays, np, cv2):
    """Normalised bboxes of dense blocks that repeat at the same position on the
    MAJORITY of pages (a running logo). A one-off diagram does not repeat → not
    matched → kept."""
    if len(grays) < 2:
        return []
    per_page = []
    for g in grays:
        H, W = g.shape
        ink = _otsu_ink(g, cv2)
        n, _, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
        if n <= 1:
            per_page.append([])
            continue
        med = float(np.median(stats[1:, cv2.CC_STAT_AREA]))
        boxes = []
        for i in range(1, n):
            x = int(stats[i, cv2.CC_STAT_LEFT]); y = int(stats[i, cv2.CC_STAT_TOP])
            bw = int(stats[i, cv2.CC_STAT_WIDTH]); bh = int(stats[i, cv2.CC_STAT_HEIGHT])
            area = int(stats[i, cv2.CC_STAT_AREA])
            if med and area >= _LOGO_MIN_AREA * med and bh < _LINE_LEN_FRAC * H and bw < _LINE_LEN_FRAC * W:
                boxes.append(_norm_box(x, y, bw, bh, W, H))
        per_page.append(boxes)

    flat = [b for page in per_page for b in page]
    logos = []
    used = [False] * len(flat)
    npages = len(grays)
    for i, b in enumerate(flat):
        if used[i]:
            continue
        cluster = [b]
        for j in range(i + 1, len(flat)):
            if not used[j] and _iou(b, flat[j]) >= _LOGO_MATCH_IOU:
                used[j] = True
                cluster.append(flat[j])
        # how many DISTINCT pages contain a box in this cluster?
        hits = 0
        for page in per_page:
            if any(_iou(b, pb) >= _LOGO_MATCH_IOU for pb in page):
                hits += 1
        if hits >= max(2, _BAND_MAJORITY * npages):
            xs0 = sum(c[0] for c in cluster) / len(cluster)
            ys0 = sum(c[1] for c in cluster) / len(cluster)
            xs1 = sum(c[2] for c in cluster) / len(cluster)
            ys1 = sum(c[3] for c in cluster) / len(cluster)
            logos.append((xs0, ys0, xs1, ys1))
    return logos
