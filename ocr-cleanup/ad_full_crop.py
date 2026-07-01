"""Full offline crop pipeline for a PRINTED/SCANNED paper — proves the end-to-end result.

For every page:  render -> REMOVE header/footer (cross-page) + background -> OCR (RapidOCR)
                 -> detect ALL seal/badge question numbers by SHAPE (recall, no OCR-read gate)
                 -> structure engine (token markers + badge boundaries) -> column-aware crop regions
                 -> crop each question from the CLEANED render -> save.

Goal: count every question (plain numbers + badges), one clean crop per question (question + options,
no header/footer/background, no neighbour bleed). Document-derived, not PDF-specific.

Usage:
  .venv/Scripts/python.exe ad_full_crop.py "C:/Users/hp/Downloads/AD 2601 Q.pdf" [--pages N] [--out DIR]
"""
from __future__ import annotations

import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:  # noqa: BLE001
    pass

import cv2  # type: ignore
import numpy as np  # type: ignore
from PIL import Image  # type: ignore

from app.structure_engine import page_chrome_cv
from app.structure_engine.geometry import compute_metrics
from app.structure_engine.marker_extractor import extract_markers
from app.structure_engine.models import PageInput, WordBox
from app.structure_engine.pipeline import analyze_document

RENDER_DPI = 200


# ── seal/badge detection by SHAPE (no OCR-read gate → full recall) ────────────────────
def detect_seal_badges(gray: "np.ndarray"):
    H, W = gray.shape
    binimg = (gray < 110).astype("uint8")
    n, _lbl, stats, _c = cv2.connectedComponentsWithStats(binimg, connectivity=8)
    lo, hi = 0.024 * W, 0.060 * W
    out = []
    for i in range(1, n):
        x, y, w, h, area = (int(stats[i][k]) for k in range(5))
        if not (lo <= w <= hi and lo <= h <= hi):
            continue
        if not (H * 0.06 < y < H * 0.93):
            continue
        if area / float(max(1, w * h)) < 0.42:
            continue
        if not (0.6 <= h / float(max(1, w)) <= 1.9):
            continue
        out.append((x, y, x + w, y + h))
    return out


_LEAD_NUM = __import__("re").compile(r"^(\d{1,3})[.)]\s+(.*)$")
_OPT = __import__("re").compile(r"^\(?[a-eA-E1-5]\)")


def column_splits(gray: "np.ndarray", blank_min: float = 0.93, merge: float = 0.10):
    """Detect column boundaries from the page render so each column is OCR'd SEPARATELY (RapidOCR is
    line-level and would otherwise read across a 2-column gutter). A gutter column is BLANK in almost
    every row — judged by the fraction of blank rows, NOT total ink, so a full-width section banner
    crossing the gutter on a few rows (e.g. 'PART-II CHEMISTRY') does NOT hide it. Adjacent blank bands
    that bound the same inter-column whitespace are merged → one cut per real column boundary. A genuine
    single-column page yields one slice. Returns [(x0,x1), ...] column slices."""
    H, W = gray.shape
    blank = (gray[int(H * 0.28):int(H * 0.96), :] >= 128)  # True = no ink
    bf = blank.mean(axis=0)  # per-column fraction of blank rows
    raw = []
    x = int(W * 0.24)
    while x < int(W * 0.76):
        if bf[x] >= blank_min:
            s = x
            while x < int(W * 0.76) and bf[x] >= blank_min:
                x += 1
            if x - s >= W * 0.008:
                raw.append([s, x])
        else:
            x += 1
    if not raw:
        return [(0, W)]
    merged = [raw[0]]
    for s, e in raw[1:]:
        if s - merged[-1][1] <= merge * W:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    cuts = [(s + e) // 2 for s, e in merged]
    bounds = [0] + cuts + [W]
    return [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]


def rapid_ocr_words(img_rgb: "np.ndarray"):
    """Full-page RapidOCR → WordBox list in render-pixel space. RapidOCR returns LINE boxes, so a line
    that starts with a question number ("1. ...") has the number glued to the stem — split it into a
    SEPARATE leading-number token (left slice of the box) so the marker extractor can see it. Each line
    is also split into whitespace words so options/markers land at the right x (the engine reasons over
    word x-positions, not whole lines)."""
    from app.ocr_engine import rapid_adapter
    if not rapid_adapter.rapid_available():
        return []
    result, _ = rapid_adapter._RAPID(img_rgb)  # type: ignore[attr-defined]
    words = []
    for entry in (result or []):
        box, text = entry[0], str(entry[1]).strip()
        if not text:
            continue
        xs = [p[0] for p in box]; ys = [p[1] for p in box]
        bx0, by0, bx1, by1 = float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))
        # split the line into whitespace tokens, distributing x by character offset (monospace-ish)
        toks = text.split()
        if not toks:
            continue
        total = sum(len(t) for t in toks) + (len(toks) - 1)
        span = max(1.0, bx1 - bx0)
        cx = bx0
        for t in toks:
            w = span * (len(t) / total)
            words.append(WordBox(text=t, x0=cx, y0=by0, x1=cx + w, y1=by1, conf=1.0))
            cx += span * ((len(t) + 1) / total)
    return words


def main(argv):
    pdf = argv[1] if len(argv) > 1 else "C:/Users/hp/Downloads/AD 2601 Q.pdf"
    max_pages = None
    out_dir = "C:/Users/hp/Downloads/new"
    for i, a in enumerate(argv):
        if a == "--pages" and i + 1 < len(argv):
            max_pages = int(argv[i + 1])
        if a == "--out" and i + 1 < len(argv):
            out_dir = argv[i + 1]
    if not os.path.exists(pdf):
        print("PDF not found:", pdf); return 1
    os.makedirs(out_dir, exist_ok=True)
    import fitz

    doc = fitz.open(pdf)
    npages = min(doc.page_count, max_pages or doc.page_count)
    print(f"Rendering {npages} page(s) @ {RENDER_DPI}dpi ...")
    renders = {}
    for i in range(npages):
        pix = doc.load_page(i).get_pixmap(dpi=RENDER_DPI, alpha=False)
        renders[i] = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    doc.close()

    # 1) REMOVE header/footer (cross-page) + background lift
    cleaned, chrome = page_chrome_cv.detect_and_clean(renders)
    print(f"chrome cleanup: headerFrac={chrome.get('headerFrac')} footerFrac={chrome.get('footerFrac')} "
          f"dividers={chrome.get('dividerCols')} skipped={chrome.get('skipped')}")

    # 2) OCR + markers + badge boundaries, per page → payload
    pages_payload = []
    cols_by_page = {}
    total_badges = 0
    for i in range(npages):
        img = cleaned[i]
        rgb = np.asarray(img)
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        # OCR each COLUMN separately (offset x back to full-page space) so RapidOCR never reads across
        # the gutter — this is what makes 2-column segmentation work, mirroring the TS column reorder.
        cols = column_splits(gray)
        cols_by_page[i + 1] = cols
        words = []
        for (cx0, cx1) in cols:
            for w in rapid_ocr_words(rgb[:, cx0:cx1]):
                w.x0 += cx0
                w.x1 += cx0
                words.append(w)
        page = PageInput(index=i + 1, width=float(img.width), height=float(img.height), words=words)
        m = compute_metrics(page)
        token_markers = extract_markers(words, m)
        badges = detect_seal_badges(gray)
        total_badges += len(badges)
        badge_markers = [{"num": None, "x0": b[0], "y0": b[1], "x1": b[2], "y1": b[3], "punct": "badge"}
                         for b in badges]
        marker_dicts = [{"num": mk.num, "x0": mk.x0, "y0": mk.y0, "x1": mk.x1, "y1": mk.y1, "punct": mk.punct}
                        for mk in token_markers] + badge_markers
        pages_payload.append({
            "index": i + 1, "width": float(img.width), "height": float(img.height),
            "words": [{"text": w.text, "x0": w.x0, "y0": w.y0, "x1": w.x1, "y1": w.y1} for w in words],
            "markers": marker_dicts,  # token numbers + badge boundaries (pre-set; no imageBase64 → no double-detect)
        })
        print(f"  page {i+1}: cols={len(cols)} words={len(words)} tokenMarkers={len(token_markers)} sealBadges={len(badges)}")

    # 3) structure engine → questions + crop regions
    result = analyze_document({"documentId": os.path.basename(pdf), "pages": pages_payload})
    qs = result.get("questions", [])
    qc = result.get("questionCount", {})
    print("=" * 70)
    print(f"LOGICAL QUESTIONS = {len(qs)}   (sealBadges detected={total_badges})")
    print(f"questionCount: logical={qc.get('logicalQuestionCount')} missing={qc.get('missingQuestions')} "
          f"recovered={qc.get('recoveredQuestions')}")

    # 4) COLUMN-LOCAL crop: each question is cropped from ITS start down to the NEXT question's start
    #    WITHIN ITS OWN COLUMN (and column x-bounds). Structure engine gives the reliable, reconciled
    #    question set (real count, no false markers); cropping is done column-locally so a right-column
    #    question never pulls in left-column content (the cross-column strip bug). One crop per question.
    from collections import defaultdict

    def _start(q):
        nb = q.get("numberBox")
        if nb:
            return int(nb[0]), float(nb[1]), float(nb[2])
        bx = (q.get("boxes") or [{}])[0]
        return int(bx.get("page", 1)), float(bx.get("x0", 0)), float(bx.get("y0", 0))

    def _col_index(page, x):
        for k, (a, b) in enumerate(cols_by_page.get(page, [(0, 10 ** 6)])):
            if a <= x < b:
                return k
        return 0

    starts = []
    for q in qs:
        pg, sx, sy = _start(q)
        ci = _col_index(pg, sx)
        starts.append({"q": q, "page": pg, "col": ci, "y": sy, "x": sx})
    by_pc = defaultdict(list)
    for s in starts:
        by_pc[(s["page"], s["col"])].append(s)
    for k in by_pc:
        by_pc[k].sort(key=lambda s: s["y"])

    saved = 0
    for (pg, ci), lst in by_pc.items():
        img = cleaned.get(pg - 1)
        if img is None:
            continue
        cx0, cx1 = cols_by_page.get(pg, [(0, img.width)])[ci]
        col_bottom = img.height * 0.94
        for idx, s in enumerate(lst):
            y0 = max(0, int(s["y"] - 6))
            y1 = int(lst[idx + 1]["y"] - 4) if idx + 1 < len(lst) else int(col_bottom)
            if y1 - y0 < 12:
                continue
            crop = img.crop((int(cx0), y0, int(cx1), y1))
            # erase the leading question-number/BADGE (UI owns numbering) + lift any faint brand
            # watermark — general, content-safe (no-op when there is nothing to erase).
            buf = io.BytesIO()
            crop.save(buf, format="PNG")
            data = buf.getvalue()
            try:
                from app.structure_engine import leading_marker, watermark_lift
                data, _ = leading_marker.erase_png(data)
                data, _ = watermark_lift.lift_png(data)
            except Exception:  # noqa: BLE001
                pass
            num = s["q"].get("number")
            with open(os.path.join(out_dir, f"q{(num or 0):03d}.png"), "wb") as fh:
                fh.write(data)
            saved += 1
    print(f"saved {saved} column-local crop(s) -> {out_dir}")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
