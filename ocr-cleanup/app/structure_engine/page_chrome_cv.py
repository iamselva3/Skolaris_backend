"""Repeated header / footer / divider removal — universal, pixel-based, document-derived.

A page header or footer (institute logo, "PRIVATE EDUCATIONAL SERVICES", a rule line, a page-number
band) is the SAME on (almost) every page, so across the page renders it has near-ZERO variance while
real question content varies page to page. A column divider / horizontal rule sits at the SAME
position on every page, so it is stable too. This detector finds that repeated chrome by cross-page
pixel STABILITY (it never reads text, so it catches a LOGO exactly like text) and whitens it in the
render the crop is cut from — so Python crops no longer carry the header/footer/divider that the old
TS display-clean used to strip.

Principles:
  • NOT PDF-centric — no hardcoded size/position/DPI/institute. Bands grow from the document's own
    pixels; every threshold is a fraction or a cross-page statistic.
  • KEEP PIXELS — whiten ONLY high-confidence repeated chrome (stable across ≥ a majority of ≥3 pages,
    bounded to a small top/bottom margin). Fewer than 3 pages, or no repeated band ⇒ do NOTHING.
  • Whitens (sets to white), never deletes geometry; content tokens/ownership are untouched.

numpy + PIL only (no cv2). Pure aside from image decode; returns cleaned renders + an audit report.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

try:
    import numpy as np  # type: ignore
    from PIL import Image  # type: ignore

    _OK = True
except Exception:  # noqa: BLE001
    _OK = False

# Cross-page comparison canvas (downscaled — fast + resolution-independent). Higher than thumbnail so
# thin repeated subtitles ("PRIVATE EDUCATIONAL SERVICES") survive. Bands map back by fraction.
_CMP_W = 320
_CMP_H = 440
# A pixel is repeated CHROME when it is near-identical across pages (low std) AND inked (dark).
_STD_T = 22.0        # 0–255; below ⇒ "the same on every page" (a little slack for resize anti-aliasing)
_INK_T = 235.0       # below ⇒ "dark enough to be ink, not paper"
# A ROW is chrome when it has ink AND most of that ink is REPEATED across pages — so a thin subtitle
# (few dark pixels, but identical on every page) still counts, while a content row (ink that varies
# page to page) does not. This is what makes the band reach the WHOLE header, not just the bold logo.
_ROW_STABLE_RATIO = 0.55  # ≥ this fraction of a row's ink must be repeated for the row to be chrome
_BLANK_ROW = 0.004        # a row with less than this inked fraction is blank (an allowed gap in a band)
_HEADER_CAP = 0.24        # never whiten more than this fraction off the TOP (safety bound)
_FOOTER_CAP = 0.18        # …or the BOTTOM
_RULE_ROW = 0.55          # a near-full-width repeated dark row = a horizontal rule (divider line)
_DIV_COL = 0.55           # a near-full-height repeated dark column = a vertical (column) divider
_MIN_PAGES = 3            # cross-page evidence needs at least this many pages


def available() -> bool:
    return _OK


def _stack(renders: Dict[int, Any]) -> Tuple[List[int], "np.ndarray"]:
    idxs = sorted(renders.keys())
    mats = []
    for i in idxs:
        im = renders[i]
        g = im.convert("L").resize((_CMP_W, _CMP_H))
        mats.append(np.asarray(g, dtype=np.float32))
    return idxs, np.stack(mats)  # (N, _CMP_H, _CMP_W)


def _band_end_top(is_chrome, is_blank, cap_rows: int) -> int:
    """Walk DOWN from the top: include chrome rows (logo / subtitle / rule) and blank gaps; stop at the
    first CONTENT row (inked but varies across pages). Return the last chrome row, or -1 if no header."""
    last = -1
    for y in range(min(cap_rows, len(is_chrome))):
        if is_chrome[y]:
            last = y
        elif is_blank[y]:
            continue  # blank gap inside the header band — keep scanning
        else:
            break     # inked content that is NOT repeated ⇒ the header has ended
    return last


def _band_start_bottom(is_chrome, is_blank, cap_rows: int) -> int:
    """Mirror of `_band_end_top` from the bottom. Return the first chrome row (band start) or len."""
    n = len(is_chrome)
    first = n
    for k in range(min(cap_rows, n)):
        y = n - 1 - k
        if is_chrome[y]:
            first = y
        elif is_blank[y]:
            continue
        else:
            break
    return first


def detect_and_clean(renders: Dict[int, Any]) -> Tuple[Dict[int, Any], Dict[str, Any]]:
    """Whiten repeated header/footer bands + stable divider lines in every page render. Returns
    (cleaned_renders, report). Best-effort: any problem ⇒ originals returned unchanged (KEEP PIXELS)."""
    report: Dict[str, Any] = {
        "available": _OK, "pages": len(renders), "skipped": None,
        "headerFrac": 0.0, "footerFrac": 0.0, "ruleRows": 0, "dividerCols": 0,
        "headerRemovals": 0, "footerRemovals": 0,
    }
    if not _OK:
        report["skipped"] = "numpy/PIL unavailable"
        return renders, report
    if len(renders) < _MIN_PAGES:
        report["skipped"] = f"<{_MIN_PAGES} pages — no cross-page evidence (KEEP PIXELS)"
        return renders, report
    try:
        idxs, arr = _stack(renders)
        mean = arr.mean(axis=0)
        std = arr.std(axis=0)
        inked = mean < _INK_T                          # dark = ink (mean across pages)
        repeated = (std < _STD_T) & inked              # dark AND identical on every page = chrome
        ink_per_row = inked.sum(axis=1).astype(np.float32)
        rep_per_row = repeated.sum(axis=1).astype(np.float32)
        inkrow = inked.mean(axis=1)
        # row is CHROME when it has ink and MOST of that ink is repeated across pages (thin subtitle OK);
        # row is BLANK when it has almost no ink (an allowed gap inside the band).
        with np.errstate(divide="ignore", invalid="ignore"):
            row_rep_ratio = np.where(ink_per_row > 0, rep_per_row / ink_per_row, 0.0)
        row_is_chrome = (inkrow >= _BLANK_ROW) & (row_rep_ratio >= _ROW_STABLE_RATIO)
        row_is_blank = inkrow < _BLANK_ROW
        rowrep = repeated.mean(axis=1)                 # per-row repeated fraction (for rule detection)
        colrep = repeated.mean(axis=0)                 # per-column repeated fraction (divider detection)

        h_end = _band_end_top(row_is_chrome, row_is_blank, int(_HEADER_CAP * _CMP_H))
        f_start = _band_start_bottom(row_is_chrome, row_is_blank, int(_FOOTER_CAP * _CMP_H))
        header_frac = (h_end + 1) / _CMP_H if h_end >= 0 else 0.0
        footer_frac = f_start / _CMP_H if f_start < _CMP_H else 1.0

        # horizontal rules INSIDE the content band (a stand-alone divider line repeated at one y).
        rule_rows = [
            y for y in range(int(header_frac * _CMP_H) + 1, int(footer_frac * _CMP_H) - 1)
            if rowrep[y] >= _RULE_ROW
        ]
        # vertical column divider(s): a repeated dark column spanning most of the height.
        div_cols = [x for x in range(_CMP_W) if colrep[x] >= _DIV_COL]

        report.update(headerFrac=round(header_frac, 4), footerFrac=round(1 - footer_frac, 4),
                      ruleRows=len(rule_rows), dividerCols=len(div_cols))

        if header_frac <= 0 and footer_frac >= 1.0 and not rule_rows and not div_cols:
            report["skipped"] = "no repeated chrome detected (clean document)"
            return renders, report

        cleaned: Dict[int, Any] = {}
        for i in idxs:
            im = renders[i].convert("RGB")
            a = np.asarray(im).copy()
            H, W = a.shape[0], a.shape[1]
            if header_frac > 0:
                a[0:max(1, int(header_frac * H)), :, :] = 255
                report["headerRemovals"] += 1
            if footer_frac < 1.0:
                a[min(H - 1, int(footer_frac * H)):H, :, :] = 255
                report["footerRemovals"] += 1
            for y in rule_rows:
                yy = int(y / _CMP_H * H)
                a[max(0, yy - 2):min(H, yy + 3), :, :] = 255   # thin band around the rule
            for x in div_cols:
                xx = int(x / _CMP_W * W)
                a[:, max(0, xx - 2):min(W, xx + 3), :] = 255    # thin band around the divider
            cleaned[i] = Image.fromarray(a, "RGB")
        return cleaned, report
    except Exception as e:  # noqa: BLE001 — never break the build over a cleanup hiccup
        report["skipped"] = f"error:{type(e).__name__}"
        return renders, report
