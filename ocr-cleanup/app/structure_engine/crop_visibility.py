"""Crop VISIBILITY validation — prove a built crop is CONTENT ONLY.

The crop owns CONTENT; the UI owns NUMBERING. A student crop must contain the question text, options,
continuations, diagrams, graphs, tables, equations and chemical structures — and must NOT contain the
question number (or page numbers / repeated headers / footers, which are already outside the
ownership-bounded crop region). The question number stays a purely INTERNAL anchor (ownership /
ordering / merging / cross-page / cross-column / N=N=C); it is erased from the delivered image.

This module is the pixel-level gate run on the constructed crop:
    question text   visible   ← content rows exist
    options         visible   ← option count meets the paper's inferred expectation (ownership)
    NUMBER          ABSENT     ← the number band carries no ink (it was removed) — else FAIL
A crop that still shows numbering is invalid and routes to review — never silently delivered.

Pure mechanics over numpy/PIL (both guarded). No IO, never raises.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

try:
    import numpy as np  # type: ignore

    _NP = True
except Exception:  # noqa: BLE001
    _NP = False


# A box in CROP-LOCAL pixel coordinates: (x0, y0, x1, y1).
LocalBox = Tuple[float, float, float, float]


def band_ink_ratio(img, box: LocalBox, thresh: int = 200) -> float:
    """Fraction of dark (ink, luminance < thresh) pixels inside `box` of a PIL crop. 0.0 when the
    box is empty/off-image or numpy is unavailable."""
    if not _NP or img is None:
        return 0.0
    w, h = img.size
    x0 = max(0, int(round(box[0])))
    y0 = max(0, int(round(box[1])))
    x1 = min(w, int(round(box[2])))
    y1 = min(h, int(round(box[3])))
    if x1 <= x0 or y1 <= y0:
        return 0.0
    arr = np.asarray(img.convert("L"))[y0:y1, x0:x1]
    if arr.size == 0:
        return 0.0
    return float((arr < thresh).mean())


def number_present(
    img,
    number_box_local: Optional[LocalBox],
    thresh: int = 200,
    min_ratio: float = 0.02,
) -> bool:
    """True when the number's own box STILL carries ink in the crop (numbering leaked through ⇒ FAIL).
    The box is checked TIGHT (no widening) so the test reads only the number's footprint, not the stem
    that sits to its right. None box ⇒ nothing to check ⇒ False (treated as content-only)."""
    if number_box_local is None:
        return False
    return band_ink_ratio(img, number_box_local, thresh) >= min_ratio


def number_visible(
    img,
    number_box_local: Optional[LocalBox],
    thresh: int = 200,
    min_ratio: float = 0.008,
) -> bool:
    """True when the number box is inked in the crop (a glyph is rendered there). Widened a touch so a
    1-px miss does not read as blank. Used pre-removal to confirm the number is present before erasing
    it; with no number box ⇒ True (do not invent a failure)."""
    if number_box_local is None:
        return True
    x0, y0, x1, y1 = number_box_local
    bw = max(2.0, (x1 - x0)) * 0.2
    bh = max(2.0, (y1 - y0)) * 0.2
    return band_ink_ratio(img, (x0 - bw, y0 - bh, x1 + bw, y1 + bh), thresh) >= min_ratio


def validate_crop(
    img,
    number_box_local: Optional[LocalBox],
    *,
    option_count: int = 0,
    expected_options: int = 4,
    multi_part: bool = False,
    has_visual: bool = False,
    ink_thresh: int = 200,
) -> Dict[str, Any]:
    """Validate one constructed crop is CONTENT ONLY. Returns:
        { numberRemoved, questionTextVisible, optionsVisible, visualsVisible, continuationsVisible,
          ok, failures[] }
    `ok` is False when the crop still shows the number, or has no content. Missing options are surfaced
    (review reason) but a 0-option subjective / diagram-only question is still valid."""
    failures: List[str] = []

    number_removed = not number_present(img, number_box_local, ink_thresh)
    if not number_removed:
        failures.append("question_number_still_in_crop")

    text_ok = _has_content(img, number_box_local, ink_thresh)
    if not text_ok:
        failures.append("question_content_not_visible")

    if option_count == 0:
        options_ok = True  # subjective / diagram-only — options N/A
    else:
        options_ok = option_count >= expected_options
        if not options_ok:
            failures.append(f"options_incomplete:{option_count}/{expected_options}")

    return {
        "numberRemoved": number_removed,
        "questionTextVisible": text_ok,
        "optionsVisible": options_ok,
        "visualsVisible": bool(has_visual),
        "continuationsVisible": bool(multi_part),
        # CONTENT-ONLY gate: a delivered crop must show content AND must NOT show the number.
        "ok": number_removed and text_ok and options_ok,
        "failures": failures,
    }


def _has_content(img, number_box_local: Optional[LocalBox], thresh: int) -> bool:
    """The crop must carry real content (it is not blank after number removal). When the number box is
    known, require ink OUTSIDE the number's own row (the stem/options/diagram); else require any ink."""
    if not _NP or img is None:
        return False
    w, h = img.size
    arr = np.asarray(img.convert("L"))
    if arr.size == 0:
        return False
    total_ink = float((arr < thresh).mean())
    if number_box_local is None:
        return total_ink >= 0.001
    _, _, _, ny1 = number_box_local
    below = arr[min(h - 1, max(0, int(round(ny1)))):, :]
    if below.size and float((below < thresh).mean()) >= 0.001:
        return True
    return total_ink >= 0.002
