"""Coordinate-space alignment validation — universal, document-derived, never PDF-specific.

The crop engine cuts the page RENDER (pixels) using boxes derived from the OCR tokens
(PDF points = ownership space). Those are DIFFERENT coordinate spaces; a single missed scale
turns every crop into a top-left fragment while every COUNT still passes. Counts alone never
prove a crop is correct — the coordinate spaces must be PROVEN to align before any crop is cut.

This module validates the whole chain on the document's OWN geometry (no hardcoded DPI, page
size, or scale — everything is a ratio derived from the inputs):

    OCR token coords ─┐
    ownership coords ─┤  one space (PDF points) — the engine builds boxes here
    page dimensions  ─┘
            │   scale = render_dimension / page_dimension      (per page, per axis)
            ▼
    render dimensions  ── the pixels the crop is cut from
            │   apply scale
            ▼
    crop coordinates   ── must land inside the render

Checks (all ratio-based, relative tolerances — universal, not tuned to any document):
  • a render exists for every page that owns content
  • scaleX ≈ scaleY            → rendering preserved aspect ratio (else points/pixels are mixed)
  • scale is consistent across pages → one render DPI (else mixed coordinate spaces in one doc)
  • scaled ownership extent fits inside the render bounds → regions are actually on-page

A page that fails ANY check is mis-aligned: its crops cannot be trusted, so the document must
route to review (KEEP PIXELS) — repair cannot fix an input-contract mismatch. Pure functions,
no IO, no PIL (render dimensions are passed in), so it is unit-testable anywhere.
"""
from __future__ import annotations

from statistics import median
from typing import Any, Dict, List, Optional, Tuple

# Relative tolerances. These are universal definitions of "the same render", NOT per-document
# tuning: a single get_pixmap(dpi=D) scales both axes by D/72, so scaleX==scaleY and every page
# shares one scale up to integer-pixel rounding. The slack only absorbs that rounding.
ASPECT_TOL = 0.03       # |scaleX-scaleY| / scale  — aspect ratio preserved by the render
CROSS_PAGE_TOL = 0.05   # per-page scale vs the document median — one DPI across the document
FIT_TOL = 0.03          # scaled ownership extent may exceed the render by at most this fraction


def _axis(render: float, page: float) -> Optional[float]:
    return (render / page) if (render > 0 and page > 0) else None


def page_scale(page_w: float, page_h: float, render_w: float, render_h: float) -> Optional[float]:
    """Render pixels per OCR point for one page, averaged over the two axes (they should match).
    None when the page or render has no usable dimensions."""
    sx, sy = _axis(render_w, page_w), _axis(render_h, page_h)
    if sx is None and sy is None:
        return None
    if sx is None:
        return sy
    if sy is None:
        return sx
    return (sx + sy) / 2.0


def validate(
    pages: List[Dict[str, Any]],
    render_dims: Dict[int, Tuple[float, float]],
    ownership_extents: Optional[Dict[int, Tuple[float, float]]] = None,
) -> Dict[str, Any]:
    """Validate that every page's coordinate spaces align.

    pages              : payload pages — each {index, width, height} in OCR-point space.
    render_dims        : {page_index: (render_w_px, render_h_px)} from the page renders.
    ownership_extents  : optional {page_index: (max_x1, max_y1)} of owned boxes in POINT space —
                         used to prove the scaled regions land inside the render (on-page).

    Returns {aligned, documentScale, scaleByPage, perPage[], reasons[]}. `aligned` is True only
    when EVERY content page passes; `scaleByPage` is the per-page scale the crop step must use
    (so a per-page render difference is honoured, not a single global guess)."""
    ownership_extents = ownership_extents or {}

    # 1) per-page raw scales (both axes) — needed before the cross-page consistency check.
    raw: Dict[int, Optional[float]] = {}
    for p in pages:
        idx = int(p.get("index"))
        rw, rh = render_dims.get(idx, (0.0, 0.0))
        raw[idx] = page_scale(float(p.get("width") or 0), float(p.get("height") or 0), rw, rh)

    known = [s for s in raw.values() if s and s > 0]
    doc_scale = float(median(known)) if known else None

    per_page: List[Dict[str, Any]] = []
    reasons: List[str] = []
    scale_by_page: Dict[int, float] = {}
    aligned = True

    for p in pages:
        idx = int(p.get("index"))
        pw, ph = float(p.get("width") or 0), float(p.get("height") or 0)
        rw, rh = render_dims.get(idx, (0.0, 0.0))
        has_content = idx in ownership_extents and ownership_extents[idx] != (0.0, 0.0)
        sx, sy = _axis(rw, pw), _axis(rh, ph)
        s = raw[idx]
        rs: List[str] = []

        if s is None or s <= 0:
            # No render (or no page dims). Only a real defect if this page owns content.
            if has_content:
                rs.append("render_missing_for_content_page")
            scale_by_page[idx] = doc_scale or 1.0
        else:
            scale_by_page[idx] = s
            # aspect: scaleX ≈ scaleY (a fixed-DPI render scales both axes equally)
            if sx and sy and abs(sx - sy) / max(sx, sy) > ASPECT_TOL:
                rs.append(f"aspect_mismatch(scaleX={sx:.3f},scaleY={sy:.3f})")
            # cross-page: this page's scale matches the document's single DPI
            if doc_scale and abs(s - doc_scale) / doc_scale > CROSS_PAGE_TOL:
                rs.append(f"scale_outlier(scale={s:.3f},docScale={doc_scale:.3f})")
            # fit: scaled ownership extent lands inside the render (regions are on-page)
            if has_content:
                ex, ey = ownership_extents[idx]
                if ex * s > rw * (1 + FIT_TOL) or ey * s > rh * (1 + FIT_TOL):
                    rs.append(
                        f"ownership_outside_render(scaledX={ex * s:.0f}/{rw:.0f},"
                        f"scaledY={ey * s:.0f}/{rh:.0f})")

        ok = not rs
        if not ok and has_content:
            aligned = False
            reasons.extend(f"p{idx}:{r}" for r in rs)
        per_page.append({
            "index": idx,
            "pageW": round(pw, 1), "pageH": round(ph, 1),
            "renderW": round(rw, 1), "renderH": round(rh, 1),
            "scaleX": round(sx, 4) if sx else None,
            "scaleY": round(sy, 4) if sy else None,
            "scale": round(s, 4) if s else None,
            "hasContent": has_content,
            "ok": ok,
            "reasons": rs,
        })

    return {
        "aligned": aligned,
        "documentScale": round(doc_scale, 4) if doc_scale else None,
        "scaleByPage": scale_by_page,
        "perPage": per_page,
        "reasons": reasons,
    }
