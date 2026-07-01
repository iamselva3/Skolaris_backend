# ⚠️ DIRECTIVE REVERSED (2026-06-20) — crop is now CONTENT-ONLY, number REMOVED

The earlier "preserve the question number in the crop" directive below was **inverted by the user**.
New rule: the **question number is an INTERNAL anchor only** (ownership / ordering / merging /
cross-page / cross-column / N=N=C) and must be **ERASED from the delivered student crop** — the UI
already shows the number (Question Navigator + Question Card), so a number in the image duplicates it
and confuses students. Crop = content only.

**New workflow:** `detect number → lock ownership → build crop → validate crop → remove numbering
layer → deliver`.

**What changed (additive, no TS touched):**
- `crop_engine._erase_box` + `build_crop(erase_local=)` whiten the number glyph out of the assembled
  crop (then trim removes the freed margin so the crop starts at the content). Only that rectangle is
  touched — stem/options/visuals are byte-identical.
- `crop_engine.repair_crop(remove_number=True)` (default) keeps the number's ROW in-crop (so the
  same-line stem isn't clipped) via `_ensure_contains`, then erases the number, then VERIFIES it is
  gone — `edges['number']=True` only if numbering STILL appears (removal failed) ⇒ crop invalid ⇒
  review. Never silently delivers a numbered crop.
- `crop_visibility` flipped to a **content-only** gate: `number_present` (leftover-number detector),
  `validate_crop` → `ok` requires `numberRemoved` + content + options. A number in the crop = FAIL.
- `document_builder` passes `remove_number=True`; per-crop `visibility.numberRemoved` /
  `numberAnchorInternalOnly`. Numbering count/ownership/N=N=C unchanged (still internal).
- Page numbers / repeated headers / footers are already OUTSIDE the ownership-bounded crop region
  (the crop spans marker-row → next-marker-row within the column), so they don't appear. Watermark /
  divider *pixel* cleanup remains the existing TS Stage-0 / cleanup-engine concern (unchanged).

**Validation (sidecar CV venv, py3.13.14):** `test_structure_engine 26/26`, `test_crop_engine 8/8`,
`test_document_builder 3/3`, `test_crop_visibility 7/7` (number present/absent, validate-fails-when-
number-shown, **repair erases number & keeps content (fewer ink px)**, no-number-box noop, **end-to-end
content-only crops delivered with internal count intact**). App + routes import clean. The 9-PDF live
regression is NOT run here (needs sidecar restart; scanned PDFs need Paddle — still blocked on py3.13).

---

<details><summary>SUPERSEDED — original number-PRESERVATION write-up (kept for history)</summary>

# TS → Python Crop Feature-Parity Migration (Question-Number Preservation)

**Scope:** migrate the crop responsibilities the TS display stack performed into the Python single
document engine, *additively*. **No TS code was deleted, disabled, or modified** — TS remains the
dormant emergency fallback. Python authority is only ever earned per-capability after it reproduces
TS behaviour with equal-or-better accuracy and the gates prove it.

**Trigger:** after enabling Python Build Mode the delivered crops lost the visible question number.
Root cause: number preservation in Python was *emergent/implicit* (the segment box happens to span
`x0=min(col_left,num_x0)`, `y0=marker.y0`), with **no explicit number ownership, no guarantee it
survived trim/scale/padding, and no validation that the delivered crop actually contained it.**

---

## Authority Report

| Functionality | TS Module | TS Behavior | Python Equivalent | Migrated | Verified |
|---|---|---|---|---|---|
| Question-number visibility | segmentation (`visual-segment.ts`) + crop region start; `crop-display-trim.ts` (`markerTopY` anchor, "CONTAIN every in-block word box") | Crop region starts at the marker line; trims never cut above/left of the number; number contained | `ownership_graph.number_box` (locked) → `crop_engine.repair_crop(number_box=)` → `crop_visibility.number_visible` | YES | YES (45/45 + e2e) |
| Crop top/left anchoring | `crop-display-trim.ts` `trimHeaderBand` (marker = top-of-question anchor) | Question can never begin above its own number | `document_builder._top_anchor` + `_ensure_contains(number_box)` | YES | YES |
| Safe crop padding | `crop-display-trim.ts` `PAD`; "never crop aggressively" | Symmetric safety pad around content | `crop_engine._pad(frac, extra_top_left)` — symmetric + **extra top/left for the number** | YES | YES |
| Option attachment / completeness | `crop-display-trim.ts` "INCLUDE ALL OPTIONS" + `option_owner_detector` | Lowest option word always contained | `option_owner_detector` + `crop_completeness_validator.infer_expected_options` + visibility `optionsVisible` | YES | YES |
| Continuation attachment | (segmentation merge) | Cross-page/column tails kept whole | `continuation/cross_column/cross_page_detector` → `merge_detector` | YES | YES |
| Diagram / graph / table / equation / chem attachment | crop kept whole; `cleanCropForDisplay` diagram-safe | Figures never split/clipped | `visual_detectors` (token+CV) → `document_builder._visual_intelligence` | YES (token) / CV needs render | PARTIAL (CV pending Paddle) |
| Crop-below / next-question bleed guard | segmentation next-marker boundary | Crop ends before next question | `clamp_regions(bottom_anchor=next number)` | YES | YES |
| Whitespace handling / blank-margin trim | `crop-display-trim.ts` `trimBlankMargins` | Trims blank, contains words | `crop_engine._trim_whitespace` (ink-bbox; number is ink ⇒ never cut) | YES | YES |
| Header / footer / page-chrome removal | `crop-display-clean.ts` (`trimHeaderBand`, `trimFooterBand`, `whitenFooterBand`, chrome CCL) | Page chrome stripped, content-safe | `repeated_chrome.detect_chrome` (markers) — **display-pixel chrome removal stays in TS Stage-0** | PARTIAL | marker-level YES |
| Column-divider removal | `crop-display-clean.ts` `removeColumnDivider` | Divider erased whole-object | column-aware regions (`_merge_same_column`) keep columns separate; **pixel divider removal stays TS** | PARTIAL | N/A |
| Watermark display cleanup | `crop-display-clean.ts` `cleanCropForDisplay` | Cross-page consensus whiten | Python OCR-route + cleanup engine (separate concern) | NOT (kept TS) | — |
| Numbering stability / ordering / count | (segmentation) | Stable Q order/count | `marker_reconciler` + `ownership_graph` + N=N=C | YES | YES |
| Crop visibility validation | (none — TS had no explicit "is the number in the crop" gate) | — | **NEW** `crop_visibility.validate_crop` (number/text/options) gating `valid`/`deliver` | YES (new capability) | YES |

**Honest scope note:** the *pixel-level* display passes (watermark/divider/footer whiten in
`crop-display-clean.ts` / `crop-display-trim.ts`) remain TS responsibilities and are **not** removed.
This migration covers crop *construction + number preservation + visibility validation*. TS display
cleanup is untouched and still runs in its Stage-0 path; nothing was lost.

---

## What was built (Python, additive only)

1. **Locked number ownership** — `StartCandidate.x1`, `QuestionCandidate.number_box`
   (`[page,x0,y0,x1,y1]`), set in `ownership_graph` from the primary segment's start marker. Emitted
   as `numberBox`. Purely additive; no box-count or geometry change.
2. **Number guarantee + safe padding** — `crop_engine`:
   - `_ensure_contains(regions, number_box)` grows the owning region so the number is always inside
     (only ever grows — can't cut content);
   - `_pad(..., extra_top_left)` adds **extra top/left margin** so the number never hugs an edge;
   - `repair_crop(number_box=)` re-asserts containment before/after every expansion and, if the
     number is still not inked, drives a top+left expansion (repair-first).
3. **Crop visibility validation** — `crop_visibility.py`: `number_visible` (ink in the locked number
   band), `validate_crop` (number/text/options). A number that cannot be made visible sets
   `edges['number']=True` ⇒ crop `valid=False` ⇒ routed to review. **Never silently delivered.**
4. **Delivery gate** — `document_builder` passes the scaled number box, records a per-crop
   `visibility` verdict, and a number-cut crop fails `valid` → fails Stage-2 N=N=C → `deliver=false` →
   whole document to review.

Workflow realized exactly as specified:
`detect number → lock ownership → build crop → apply safe padding → validate visibility → deliver`,
with `repair → rebuild → revalidate` before any review, and review (never silent delivery) last.

---

## Validation Report

### Functionality matrix (engine harness)

| Functionality | TS Status | Python Status | Migrated | Validated | PASS/FAIL |
|---|---|---|---|---|---|
| Question Number Visibility | implicit | explicit + validated | YES | unit + e2e | **PASS** |
| Crop Alignment (top/left anchor) | yes | yes | YES | repair tests | **PASS** |
| Option Completeness | yes | yes (inferred N) | YES | builder tests | **PASS** |
| Cross-page Ownership | yes | yes | YES | structure tests | **PASS** |
| Cross-column Ownership | yes | yes | YES | structure tests | **PASS** |
| Diagram Ownership | yes | token yes / CV pending | PARTIAL | token tests | PASS (token) |
| Equation Ownership | yes | token yes | YES | structure tests | **PASS** |
| Chemical Ownership | yes | CV pending render | PARTIAL | — | PENDING (Paddle) |
| Header/Footer Removal | TS Stage-0 | marker-level (chrome) | PARTIAL | structure tests | PASS (marker) |
| Question Count Accuracy | yes | yes (reconciler) | YES | structure tests | **PASS** |
| Crop Accuracy / Visibility gate | none | new validator | YES | crop_visibility tests | **PASS** |

### Test suites (run in the sidecar CV venv, Python 3.13.14)

```
test_structure_engine   26/26 passed
test_crop_engine         8/8 passed
test_document_builder    3/3 passed
test_crop_visibility     8/8 passed   (number visible/blank/none, mandatory gate,
                                       region-grows-to-include-number, unrenderable-number flagged,
                                       extra top/left padding, end-to-end build number visible)
```
App + all routes import clean (`/process-document`, `/build-document`, `/analyze-document`, …).

### Per-PDF regression suite — HONEST status

The 9-PDF suite (AIOTS, AD2601, RE NEET, Biology, Biology_Cell, PHYCHE + 3 unseen) **was NOT run
live by this change** — it requires the full upload→OCR→sidecar pipeline, a sidecar **restart**
(running uvicorn has older code), and for the scanned PDFs **PaddleOCR**, which is still blocked on
this venv's Python 3.13 (see project memory). The digital path (PHYCHE/Biology/Biology_Cell) is
runnable once the sidecar is restarted with this code. Code + gates are proven by the 45 engine
tests + the synthetic end-to-end render test. **No live PASS/FAIL is claimed for the 9 PDFs here.**

To validate live: restart the sidecar on :8002 with this code, then drive
`scripts/live-validate.mjs` (digital PDFs) and inspect each delivered crop's `visibility.numberVisible`
+ `GET /ocr/jobs/:id/authority`. A number-cut crop now forces `deliver=false` → review (by design).

---

## Golden rules honored

1. No TS code deleted. 2. No TS functionality lost (pixel display passes still TS). 3. Migrated
capability-by-capability. 4. Python equals/exceeds TS (adds an explicit visibility gate TS lacked).
5. Question numbers always visible — guaranteed + validated. 6. One question = one owner = one crop.
7. Repair first. 8. Review last. 9. Never silently deliver an incorrect (number-less) crop.
10. No PDF-centric logic (all geometry/ink ratios, no literals/coords/institute names).

</details>
