# Protected-Region work — status after 2026-06-24 session

**Context.** `figure_regions.py` (pixel figure detection → option suppression → figure→question
ownership) correctly fixes *diagram-label-as-option* and *figure slicing*. Three additional root
causes were diagnosed for **`RE NEET PST 3 (1)-1-4.pdf`** (25 REP 4-page, capture `3dc911a2`).
All three are now **SHIPPED** (2026-06-24). Engine tests: **95/95** (was 91/91 before session).

## `word.protected` — the universal Protected-Region flag

**New field `WordBox.protected: bool = False`** ([models.py](app/structure_engine/models.py)).

A protected word is inside a detected figure (diagram, graph, circuit, formula). Rules:
- **KEEP PIXELS** — the word stays in every word list; it renders in the crop; its text is visible.
- **NEVER promote to structure** — skipped by marker extraction, option detection, and column geometry.

Pipeline step 2d.1 ([pipeline.py](app/structure_engine/pipeline.py)) calls `tag_protected_words()`
([figure_regions.py](app/structure_engine/figure_regions.py)) after figure detection and before
segmentation, so all downstream consumers (steps 3–6) see the flag without receiving `figure_boxes`.

---

## Gap A — page-classifier false positive (SHIPPED)
**Was:** Page 1 classified ANSWER_KEY because instructions said "…on the answer **sheet**" →
Q1–4 lost.

**Fix:** Pipeline step 2.0c post-hoc correction: a keyword-triggered ANSWER_KEY candidate whose
markers start the document sequence (min_marker ≤ doc_min + 1) is re-classified as QUESTION.
The keyword is in the OMR instructions, not in actual answer data; a genuine key never starts
the sequence. **Seam:** `pipeline.py` only; `page_classifier.py` unchanged.

---

## Gap B — `num >= 1` floor + protected-word skip in marker extraction (SHIPPED)

**Part 1 (`num < 1` floor):** already present in `marker_extractor.py:140` before this session.
Rejects `0.` → num=0 (circuit/binary diagram OCR). Zero-risk TS parity.

**Part 2 (`protected` skip in `extract_markers`):** added at step 1b entry ([marker_extractor.py](app/structure_engine/marker_extractor.py)). Currently a future-proof guard (markers extracted before
tagging); effective if pipeline order ever changes.

**Part 3 (`_in_figure` fast-path):** `option_owner_detector._in_figure` now checks `w.protected`
first ([option_owner_detector.py](app/structure_engine/option_owner_detector.py)). Effective at
step 5 where words ARE tagged → no diagram label can become an MCQ option.

---

## Gap C — horizontal clipping (SHIPPED via crop_planner x-extension)
**Was:** `col.right = 258` for a page where diagram strokes extend to x=700 → crop clips at 258.

**Root cause (column narrowing):** `detect_columns` projects word ink; diagram strokes have no
words in x=258–700, so `cx1 = max(w.x1 for words) = 258` → column right edge = 258.

**Fix:** `crop_planner._plan_one` figure-protection block extended to include x:
```python
for _vx0, _vy0, _vx1, _vy1 in [(e[0], e[1], e[2], e[3]) for e in elems if e[5]]:
    if _vy0 <= y1 + 0.5 * mh and _vy1 > y1:
        y1 = _vy1
    if _vx1 > x1:
        x1 = _vx1  # diagram wider than detected column
```
An owned DIAGRAM box (assigned by `assign_figures_to_questions`) extends the crop to its full
width, bypassing the column right-edge constraint. Then frame-x clamp and page-bound clamp apply
normally. **Seam:** `crop_planner.py` only; no column geometry changed.

---

## Evidence baseline (offline, capture `3dc911a2`, 4 pages 1224×1584)
- Before fixes: **18 questions** (Q1–4 lost via Gap A, diagram labels as options via concurrent fix)
- After Gap A: Q1–4 recovered → **22 questions** (pending baseline re-run with image_base64)
- Beyond 22: genuinely unread handwritten numbers — not a logic bug, needs handwriting-OCR

Reproduce (offline, no live run needed):
```python
PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe
from app.structure_engine.pipeline import analyze_document
# load capture 3dc911a2 from STRUCTURE_CAPTURE_DIR and call analyze_document
```

---

## Regression anchors (must not drop)
| Capture | logical | cropValid |
|---|---|---|
| PHYCHE (18p `2d28720c`) | 50 | 50 |
| RE-NEET-ish (25p `e21a4506`) | 177 | 140 |
| AD 2601 (19p `33d46aa4`) | 187 | 124 |
| AIOTS (24p `e1ac37b9`) | 170 | 114 |
| 25 REP (29p `cc7f563e`) | 116 | 72 |
| **25 REP 4p (`3dc911a2`, target)** | **18 → 22+** | **12 → higher** |

Engine unit tests: **95/95** via `run_tests.py` — keep green.

## Remaining open items
- **Handwriting OCR** (25 REP Q23–32): OCR never read those numbers; needs TrOCR/EasyOCR region
  model. Analysis-only recommendation; no engine change yet.
- **Column 2-column collapse on diagram-sparse pages** (pages 1,3 of 25 REP 4p): `column_pixels`
  refine may already fix from pixels; if not, `detect_columns` could re-run after step 2d.1 tagging
  with structural words only, validated by marker coverage. Not built — regression risk (AD 2-col).
