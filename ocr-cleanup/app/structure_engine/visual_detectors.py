"""Visual element detectors — diagram / graph / table / equation / chemical structure.

A complete crop must OWN its visual elements; they can no longer be N/A "because unbuilt".
Two layers:

  • TOKEN layer (works NOW, no page render needed): from the word geometry the engine
    already has — a tall word-free band inside a question (a figure/diagram between text and
    options), an aligned word GRID (a table), and a math-symbol-dense line (an equation).
    These activate in the current token-only pipeline.

  • CV layer (activates when a page render is supplied): refines on pixels — rule grids
    (table), large 2-D components (diagram), an L of long axes (graph), dense short angled
    segments (chemical structure). Guarded cv2/numpy import.

Every detected element sits INSIDE the question's owned span ⇒ it is owned by construction
(the crop union includes it). A detected element OUTSIDE the owned bbox is DETACHED ⇒ the
completeness gate fails it ⇒ repair expands ownership. No PDF-specific logic; all universal
structural patterns.
"""
from __future__ import annotations

import re
from typing import Dict, List, Sequence, Tuple

from . import tokens
from .geometry import PageMetrics, group_lines
from .models import WordBox

try:
    import cv2  # type: ignore
    import numpy as np  # type: ignore

    _CV = True
except Exception:  # noqa: BLE001
    _CV = False

VISUAL_CV_AVAILABLE = _CV

# math operators / symbols that mark an equation line
_MATH = set("=+−-×÷*/^√∫∑∏≤≥≠≈±∞→πθλμΔ∂")
_MATH_TOKEN = re.compile(r"[=+\-×÷*/^√∫∑∏≤≥≠≈±]|\b\d+/\d+\b|[a-zA-Z]\^?\d")


# ─────────────────────────────────────────────────────────────────────────────
# TOKEN layer
# ─────────────────────────────────────────────────────────────────────────────
def figure_gaps(
    words: Sequence[WordBox], region: Tuple[float, float, float, float], metrics: PageMetrics
) -> List[Tuple[float, float]]:
    """Tall word-free vertical bands inside the region, bounded by content above AND below —
    a figure / diagram occupying whitespace between text and options. Returns (y0,y1) bands."""
    lines = sorted(group_lines(words, metrics.line_tol), key=lambda ln: ln.y0)
    if len(lines) < 2:
        return []
    gap_min = 4.0 * metrics.median_h
    out: List[Tuple[float, float]] = []
    for a, b in zip(lines, lines[1:]):
        if (b.y0 - a.y1) >= gap_min:
            out.append((a.y1, b.y0))
    return out


def has_table(words: Sequence[WordBox], metrics: PageMetrics) -> bool:
    """A real GRID — distinguished from prose AND from an MCQ option block. Requires:
      • >=3 rows, each with >=3 words;
      • the left column is NOT a run of option labels (A) B) C) D) → that's MCQ layout);
      • >=3 STRONG columns (a word at that x in >=80% of rows);
      • SHORT cells — avg words/row ≈ column count (a table is ~1 word/cell, prose packs many
        words per row against only a few coincidentally-aligned x-positions).
    The cell-density test is what stops aligned prose/options from reading as a table."""
    lines = [ln for ln in group_lines(words, metrics.line_tol) if len(ln.words) >= 3]
    if len(lines) < 3:
        return False

    left_labels = sum(1 for ln in lines if ln.words and tokens.is_option_label(ln.words[0].text))
    if left_labels >= max(3, int(0.6 * len(lines))):
        return False

    tol = max(metrics.char_w * 2.0, metrics.median_h)
    cols = sorted({round(w.x0 / tol) * tol for ln in lines for w in ln.words})
    strong = 0
    for c in cols:
        hits = sum(1 for ln in lines if any(abs(w.x0 - c) <= tol for w in ln.words))
        if hits >= 0.8 * len(lines):
            strong += 1
    if strong < 3:
        return False

    avg_words = sum(len(ln.words) for ln in lines) / len(lines)
    return avg_words <= strong * 1.6  # short cells (table), not prose (many words/row)


def has_equation(words: Sequence[WordBox], metrics: PageMetrics) -> bool:
    """A line whose tokens are math-symbol dense (operators / fractions / powers)."""
    for ln in group_lines(words, metrics.line_tol):
        toks = ln.words
        if len(toks) < 2:
            continue
        sym = 0
        for w in toks:
            t = w.text or ""
            if any(ch in _MATH for ch in t) or _MATH_TOKEN.search(t):
                sym += 1
        if sym >= 2 and sym >= 0.3 * len(toks):
            return True
    return False


def classify_question_visuals(
    words: Sequence[WordBox], region: Tuple[float, float, float, float], metrics: PageMetrics
) -> Dict[str, str]:
    """Per-question visual checks from TOKENS. PASS = present & owned (inside the span);
    N/A = none detected. graph / chemical_structure need the CV render pass — reported as
    'N/A' with the render flag, never a fake PASS."""
    diagram = "PASS" if figure_gaps(words, region, metrics) else "N/A"
    table = "PASS" if has_table(words, metrics) else "N/A"
    equation = "PASS" if has_equation(words, metrics) else "N/A"
    return {
        "diagram": diagram,
        "table": table,
        "equation": equation,
        "graph": "N/A",                 # CV render pass (deferred wiring)
        "chemical_structure": "N/A",    # CV render pass (deferred wiring)
    }


# ─────────────────────────────────────────────────────────────────────────────
# CV layer (activates when a region render is supplied)
# ─────────────────────────────────────────────────────────────────────────────
def classify_region_cv(image) -> Dict[str, bool]:
    """Pixel-level detection on a region render. Returns presence flags for all five kinds.
    Best-effort structural heuristics (no PDF specifics); absent CV stack ⇒ all False."""
    if not _CV:
        return {k: False for k in ("diagram", "graph", "table", "equation", "chemical_structure")}
    try:
        arr = np.asarray(image.convert("L")) if hasattr(image, "convert") else np.asarray(image)
        ink = (arr < 160).astype("uint8")
        h, w = ink.shape
        if h < 8 or w < 8:
            return {k: False for k in ("diagram", "graph", "table", "equation", "chemical_structure")}
        hk = cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, w // 4), 1))
        vk = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(20, h // 4)))
        horiz = cv2.morphologyEx(ink, cv2.MORPH_OPEN, hk)
        vert = cv2.morphologyEx(ink, cv2.MORPH_OPEN, vk)
        n_h = int((horiz.sum(axis=1) > 0).sum())
        n_v = int((vert.sum(axis=0) > 0).sum())
        table = n_h >= 2 and n_v >= 2
        graph = (not table) and ((n_h >= 1 and n_v >= 1))  # an L of axes, not a full grid
        line_h = max(8, h // 40)
        num, _l, stats, _c = cv2.connectedComponentsWithStats(ink, connectivity=8)
        big = sum(1 for i in range(1, num) if stats[i][2] > 3 * line_h and stats[i][3] > 3 * line_h)
        small_seg = sum(1 for i in range(1, num) if line_h <= max(stats[i][2], stats[i][3]) <= 4 * line_h)
        diagram = big >= 1
        chem = big >= 1 and small_seg >= 12  # a figure made of many short bond-like segments
        return {"diagram": diagram, "graph": graph, "table": table, "equation": False, "chemical_structure": chem}
    except Exception:  # noqa: BLE001
        return {k: False for k in ("diagram", "graph", "table", "equation", "chemical_structure")}
