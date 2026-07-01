"""Universal PIXEL-based header/footer chrome bands — logo-aware, document-derived, never PDF-centric.

The token-based `repeated_chrome` can only see chrome made of OCR WORDS. A real institute header/footer is
often an IMAGE: a logo ("THE SK LEARNINGS"), a coloured banner, a phone-number strip, or — on a scan — a
solid dark border. None of those are words, so the token detector is blind to them and they land inside the
delivered crop (the footer the reviewer keeps seeing). This detector reads the page PIXELS instead, so it
catches a logo exactly like text: a header/footer is the part of the page that is (near-)IDENTICAL across
the document's pages, while question content varies page to page.

Why per-RESOLUTION groups: a single upload can concatenate several papers (e.g. "AIOTS 1 & DR09"), each
rendered at its OWN size/DPI and carrying its OWN header/footer. Cross-page stability is therefore measured
WITHIN each group of same-size pages — so each paper's chrome is found against its own pages, and a
3490×4936 scanned paper's footer is not diluted by a 1337×1891 digital paper's different footer.

Returns, per 1-based page index, a (header_bottom_y, footer_top_y) band in that page's OWN pixel space (the
same space as the OCR word boxes / crop regions), so the crop planner clips every crop to it. KEEP-PIXELS:
a group with < 3 pages, or no stable band, yields nothing for those pages. numpy + PIL only; never raises.
"""
from __future__ import annotations

import base64
from collections import defaultdict
from typing import Any, Dict, List, Tuple

try:
    import numpy as np  # type: ignore
    from PIL import Image  # type: ignore

    _OK = True
except Exception:  # noqa: BLE001
    _OK = False

# Downscaled cross-page comparison canvas (resolution-independent; bands map back by fraction). Tall enough
# that a thin repeated subtitle ("PRIVATE EDUCATIONAL SERVICES") still occupies ≥1 row.
_CMP_W = 320
_CMP_H = 480
_STD_T = 26.0          # 0–255: per-pixel std below this across pages ⇒ "the same on every page"
_INK_T = 235.0         # mean intensity below this ⇒ dark (ink/logo), not paper
_DARK_T = 90.0         # mean intensity below this ⇒ a SOLID dark band (scan border) — chrome regardless
_ROW_STABLE_RATIO = 0.55   # ≥ this fraction of a row's ink must be repeated for the row to count as chrome
_BLANK_ROW = 0.004         # below this inked fraction the row is blank (an allowed gap inside a band)
_HEADER_CAP = 0.26         # never call more than this fraction off the TOP chrome (safety bound)
_FOOTER_CAP = 0.22         # …or the BOTTOM
_MIN_PAGES = 3             # cross-page evidence needs at least this many same-size pages


def available() -> bool:
    return _OK


def _decode_gray(b64: str):
    try:
        from io import BytesIO

        return Image.open(BytesIO(base64.b64decode(b64))).convert("L")
    except Exception:  # noqa: BLE001
        return None


def _band_end_top(is_chrome, is_blank, cap_rows: int) -> int:
    """Walk DOWN from row 0: keep chrome rows + blank gaps, stop at the first CONTENT row. Last chrome row."""
    last = -1
    for y in range(min(cap_rows, len(is_chrome))):
        if is_chrome[y]:
            last = y
        elif is_blank[y]:
            continue
        else:
            break
    return last


def _band_start_bottom(is_chrome, is_blank, cap_rows: int) -> int:
    """Mirror of `_band_end_top` from the bottom. First chrome row of the footer band, or len (no footer)."""
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


def _group_band_fracs(grays: List["Image.Image"]) -> Tuple[float, float]:
    """(header_frac, footer_frac) for a group of same-size page renders, via cross-page pixel stability.
    header_frac = fraction of height that is top chrome; footer_frac = the y where bottom chrome STARTS
    (so [footer_frac*H : H] is chrome). (0.0, 1.0) means no band. Best-effort; (0,1) on any problem."""
    try:
        mats = [np.asarray(g.resize((_CMP_W, _CMP_H)), dtype=np.float32) for g in grays]
        arr = np.stack(mats)
        mean = arr.mean(axis=0)
        std = arr.std(axis=0)
        inked = mean < _INK_T
        repeated = ((std < _STD_T) & inked) | (mean < _DARK_T)   # identical-dark OR solid-dark (scan border)
        ink_per_row = inked.sum(axis=1).astype(np.float32)
        rep_per_row = repeated.sum(axis=1).astype(np.float32)
        inkrow = inked.mean(axis=1)
        with np.errstate(divide="ignore", invalid="ignore"):
            row_rep_ratio = np.where(ink_per_row > 0, rep_per_row / ink_per_row, 0.0)
        row_is_chrome = (inkrow >= _BLANK_ROW) & (row_rep_ratio >= _ROW_STABLE_RATIO)
        row_is_blank = inkrow < _BLANK_ROW
        h_end = _band_end_top(row_is_chrome, row_is_blank, int(_HEADER_CAP * _CMP_H))
        f_start = _band_start_bottom(row_is_chrome, row_is_blank, int(_FOOTER_CAP * _CMP_H))
        header_frac = (h_end + 1) / _CMP_H if h_end >= 0 else 0.0
        footer_frac = f_start / _CMP_H if f_start < _CMP_H else 1.0
        return header_frac, footer_frac
    except Exception:  # noqa: BLE001
        return 0.0, 1.0


def pixel_chrome_bands(pages: List[Any]) -> Dict[int, Tuple[float, float]]:
    """Per 1-based page index → (header_bottom_y, footer_top_y) in that page's OWN pixel space.

    Pages are grouped by (round(width), round(height)); within each group of ≥ _MIN_PAGES the cross-page
    stable top/bottom chrome bands are found and mapped to each page's height. Pages with no detected band
    are absent from the result (KEEP PIXELS)."""
    if not _OK:
        return {}
    groups: Dict[Tuple[int, int], List[Any]] = defaultdict(list)
    for p in pages:
        if p.image_base64:
            groups[(round(p.width), round(p.height))].append(p)

    out: Dict[int, Tuple[float, float]] = {}
    for _key, grp in groups.items():
        if len(grp) < _MIN_PAGES:
            continue
        grays = []
        kept = []
        for p in grp:
            g = _decode_gray(p.image_base64)
            if g is not None:
                grays.append(g)
                kept.append(p)
        if len(grays) < _MIN_PAGES:
            continue
        header_frac, footer_frac = _group_band_fracs(grays)
        if header_frac <= 0.0 and footer_frac >= 1.0:
            continue
        for p in kept:
            h = float(p.height) or 1.0
            header_bottom = header_frac * h if header_frac > 0.0 else 0.0
            footer_top = footer_frac * h if footer_frac < 1.0 else h
            out[p.index] = (round(header_bottom, 2), round(footer_top, 2))
    return out


def merge_bands(
    token_bands: Dict[int, Tuple[float, float]],
    pixel_bands: Dict[int, Tuple[float, float]],
    page_heights: Dict[int, float],
) -> Dict[int, Tuple[float, float]]:
    """Merge token-derived and pixel-derived bands into the TIGHTEST safe clip per page: the LOWEST
    header_bottom-most and the HIGHEST footer_top-most of the two (so whichever detector saw more chrome
    wins, and neither relaxes the other). Pages present in only one source keep that source's band."""
    out: Dict[int, Tuple[float, float]] = {}
    for pi in set(token_bands) | set(pixel_bands):
        h = float(page_heights.get(pi, 0.0)) or 0.0
        tb = token_bands.get(pi)
        pb = pixel_bands.get(pi)
        hb = max((b[0] for b in (tb, pb) if b), default=0.0)
        ftops = [b[1] for b in (tb, pb) if b and b[1] and b[1] > 0]
        ft = min(ftops) if ftops else (h if h else 0.0)
        out[pi] = (hb, ft)
    return out
