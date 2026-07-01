"""PIXEL-based column-gutter detection — robust where the token detector fails, document-derived.

`geometry.detect_columns` reasons over OCR WORD boxes. On a clean digital page that is reliable, but on a
SCANNED / high-DPI page the OCR is sparse and noisy (a 2-column page may yield only a few hundred words with
ragged line grouping), so the gutter's "content on both sides on ≥30% of lines" test fails and the page
collapses to ONE column — then every crop spans BOTH columns (the full-page crop that swallows the
neighbouring question). This detector finds the gutter from the page PIXELS instead: a column gutter is a
vertical band that is BLANK on almost every BODY row, with real ink on both sides. Pixels don't depend on OCR
quality, so it survives a poor scan.

It is used to REFINE the token columns: when the pixels reveal a gutter the tokens missed, the page is split
into the pixel columns; otherwise the token columns stand. Never PDF-specific — every threshold is a fraction
of the page's own width/height or derived from its own ink. numpy + PIL only; never raises (falls back to the
token columns).
"""
from __future__ import annotations

import base64
from io import BytesIO
from typing import Any, List, Optional, Tuple

try:
    import numpy as np  # type: ignore
    from PIL import Image  # type: ignore

    _OK = True
except Exception:  # noqa: BLE001
    _OK = False

_INK = 160              # pixel intensity below this is ink (a little darker than paper)
_BLANK_COL_ROWS = 0.965  # a gutter column is blank on ≥ this fraction of body rows (slack for scan noise /
#                          a faint diagonal watermark crossing the gutter; the side-ink + min-gutter-width +
#                          min-column-width guards below stop a wide paragraph gap from becoming a column)
_MIN_GUTTER_FRAC = 0.018  # a real gutter is ≥ this fraction of page width wide
_SEARCH_LO = 0.20        # only look for an internal gutter between these x-fractions …
_SEARCH_HI = 0.80        # … (the outer margins are not column boundaries)
_SIDE_INK_FRAC = 0.02    # each side of a gutter must carry ≥ this fraction of inked body rows
# A thin vertical RULE line drawn down the centre of a gutter (the institute box / column divider) leaves
# an inked strip that splits one blank gutter into two adjacent blank bands. Merge bands separated by less
# than this fraction of the width so the rule does NOT manufacture a sliver "column". A real column between
# two gutters is far wider than this, so genuine 3-column layouts are unaffected.
_RULE_MERGE_FRAC = 0.045
_MIN_COL_FRAC = 0.12     # a real column is ≥ this fraction of page width; narrower ⇒ a sliver, not a column


def available() -> bool:
    return _OK


def _decode_gray(b64: str):
    try:
        return np.asarray(Image.open(BytesIO(base64.b64decode(b64))).convert("L"))
    except Exception:  # noqa: BLE001
        return None


def detect_gutters(
    gray: "np.ndarray", body_y0_frac: float = 0.16, body_y1_frac: float = 0.94
) -> List[Tuple[int, int]]:
    """Vertical gutter bands [(x0,x1), ...] from the page's ink projection over the BODY rows (header/footer
    excluded by fraction so a full-width banner never fills the gutter). A gutter column is blank on almost
    every body row; adjacent blank columns merge into one gutter; only gutters with ink on BOTH sides and
    wide enough to be a real column gap are returned. Empty ⇒ single column."""
    H, W = gray.shape[:2]
    if H < 10 or W < 10:
        return []
    y0 = max(0, int(H * body_y0_frac))
    y1 = min(H, int(H * body_y1_frac))
    body = gray[y0:y1, :]
    ink = body < _INK                              # True = ink
    blank_frac = 1.0 - ink.mean(axis=0)            # per-column fraction of BLANK rows
    inked_rows_per_col = ink.sum(axis=0)
    total_rows = max(1, body.shape[0])

    lo, hi = int(W * _SEARCH_LO), int(W * _SEARCH_HI)
    min_w = max(4, int(W * _MIN_GUTTER_FRAC))
    side_min = _SIDE_INK_FRAC * total_rows

    raw: List[List[int]] = []
    x = lo
    while x < hi:
        if blank_frac[x] >= _BLANK_COL_ROWS:
            s = x
            while x < hi and blank_frac[x] >= _BLANK_COL_ROWS:
                x += 1
            raw.append([s, x])
        else:
            x += 1
    # MERGE blank bands separated only by a thin inked strip (a centre RULE/divider line) — one real gutter.
    merge_gap = _RULE_MERGE_FRAC * W
    merged: List[List[int]] = []
    for s, e in raw:
        if merged and (s - merged[-1][1]) <= merge_gap:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    out: List[Tuple[int, int]] = []
    for s, e in merged:
        if (e - s) < min_w:
            continue
        # ink must exist on BOTH sides within this column band — a true column boundary, not a wide blank
        # paragraph indent or a margin. Measured over the whole page width on each side.
        left_ink = inked_rows_per_col[:s].sum() > side_min * 1.0
        right_ink = inked_rows_per_col[e:].sum() > side_min * 1.0
        if left_ink and right_ink:
            out.append((s, e))
    return out


_CENTER_LO = 0.30        # a 2-column gutter sits near the horizontal centre — search only this band so a
_CENTER_HI = 0.70        # wide right-margin / paragraph gap on a 1-column page is never mistaken for one


def _best_central_gutter(gray: "np.ndarray", by0: float, by1: float) -> Optional[Tuple[int, int]]:
    """The single widest CENTRAL vertical blank band (a 2-column gutter), or None. Restricted to the centre
    so a single-column page — whose text crosses the centre — yields nothing, while its blank outer margins
    are ignored. The band must be wide enough, deep (mostly blank), and have real ink on BOTH sides."""
    H, W = gray.shape[:2]
    y0 = max(0, int(H * by0))
    y1 = min(H, int(H * by1))
    body = gray[y0:y1, :]
    ink = body < _INK
    blank_frac = 1.0 - ink.mean(axis=0)
    inked_rows_per_col = ink.sum(axis=0)
    total_rows = max(1, body.shape[0])

    lo, hi = int(W * _CENTER_LO), int(W * _CENTER_HI)
    min_w = max(4, int(W * _MIN_GUTTER_FRAC))
    side_min = _SIDE_INK_FRAC * total_rows
    merge_gap = _RULE_MERGE_FRAC * W

    raw: List[List[int]] = []
    x = lo
    while x < hi:
        if blank_frac[x] >= _BLANK_COL_ROWS:
            s = x
            while x < hi and blank_frac[x] >= _BLANK_COL_ROWS:
                x += 1
            raw.append([s, x])
        else:
            x += 1
    merged: List[List[int]] = []
    for s, e in raw:
        if merged and (s - merged[-1][1]) <= merge_gap:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    best: Optional[Tuple[int, int]] = None
    best_w = 0
    for s, e in merged:
        if (e - s) < min_w:
            continue
        if inked_rows_per_col[:s].sum() <= side_min or inked_rows_per_col[e:].sum() <= side_min:
            continue
        if (e - s) > best_w:
            best, best_w = (s, e), (e - s)
    return best


def refine_columns(
    page: Any,
    token_columns: List[Any],
    body_band: Optional[Tuple[float, float]] = None,
):
    """Return a refined geometry.Column list for a page. SCOPE: only recover a gutter when the TOKEN detector
    collapsed the page to a SINGLE column (the scanned/sparse-OCR failure that produces full-width crops) —
    a page the tokens already split into ≥2 columns is trusted and returned unchanged (so a wide in-column
    paragraph gap is never mistaken for a new column). For a 1-column page, find the single best CENTRAL
    gutter from the pixels and split into two real columns when one exists. No image / no central gutter ⇒
    token columns. `body_band` (header_bottom_y, footer_top_y) scopes the projection to content rows."""
    from .geometry import Column

    if not _OK or len(token_columns) > 1 or not getattr(page, "image_base64", None):
        return token_columns
    gray = _decode_gray(page.image_base64)
    if gray is None:
        return token_columns
    H, W = gray.shape[:2]
    by0, by1 = 0.16, 0.94
    if body_band and H > 0:
        hb, ft = body_band
        if hb and hb > 0:
            by0 = min(0.45, max(0.05, hb / H + 0.005))
        if ft and 0 < ft < H:
            by1 = max(0.55, min(0.98, ft / H - 0.005))
    gutter = _best_central_gutter(gray, by0, by1)
    if gutter is None:
        return token_columns
    ink_cols = np.where((gray < _INK).sum(axis=0) > 0)[0]
    if ink_cols.size == 0:
        return token_columns
    cx0, cx1 = float(ink_cols.min()), float(ink_cols.max())
    mid = (gutter[0] + gutter[1]) / 2.0
    cols = [Column(left=cx0, right=mid), Column(left=mid, right=cx1)]
    # SAFETY: both halves must be real columns (≥ _MIN_COL_FRAC of the width).
    min_col_w = _MIN_COL_FRAC * W
    if any((c.right - c.left) < min_col_w for c in cols):
        return token_columns
    return cols
