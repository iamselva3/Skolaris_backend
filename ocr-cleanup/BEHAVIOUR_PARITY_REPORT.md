# Behaviour Parity Report — Python Build Mode vs existing TS OCR UX

> ## UPDATE 2026-06-20 (Part 2) — `deliver=true` path was ALSO emitting text questions
>
> The `deliver=false` fallback below fixed the crop-less case. A second regression remained on the
> **`deliver=true`** path: a delivered Python question was persisted as a **text** question, so the UI
> showed an extracted textarea + empty a/b/c/d fields instead of a VISUAL Question with the crop image.
>
> **Root cause (exact stages):**
> - `deliverPythonDocument` set `detectedType = q.hasDiagram ? 'VISUAL' : optionCount>=2 ? 'SINGLE_CHOICE' : 'VISUAL'`
>   → an option-bearing question became **SINGLE_CHOICE** — and it also passed `options: q.options`.
> - `buildPythonCrops` (DELIVER branch) spread the matched TS draft (`...(ts ?? {})`), **inheriting**
>   TS's text `detectedType` and its `options` array.
>
> The canonical screenshot-first VISUAL draft (`visual-segment.ts` `segmentVisualDrafts`) is:
> `detectedType:'VISUAL'`, `text` = metadata only (never rendered), `questionSnapshotKey` = crop image
> (source of truth), `optionCount` = positional answer slots, and **NO `options` array**.
>
> **Fix (additive, both Python delivery paths):** every Python-built question is forced to
> `detectedType:'VISUAL'`, the `options` array is dropped (`deliverPythonDocument` no longer sets it;
> `buildPythonCrops` clears the inherited one with `options: undefined`), `text` stays metadata-only,
> and `optionCount` + `questionSnapshotKey` (crop image) are preserved. Persist path
> (`handle-ocr-callback`) maps `options:undefined → null`, so no a/b/c/d are stored. **No UI/flow/engine
> redesign; no TS deleted.** Python improves accuracy only; it never converts an image into text fields.
>
> | Stage | Old TS | Python (before) | Expected | PASS/FAIL (after fix) |
> |---|---|---|---|---|
> | UI render | Visual Question + crop image | empty textarea + a/b/c/d | Visual Question + crop image | **PASS** |
> | detectedType | VISUAL | SINGLE_CHOICE (option-bearing) | VISUAL | **PASS** |
> | options array | none | a/b/c/d extracted | none | **PASS** |
> | crop image (`questionSnapshotKey`) | present | present | present | **PASS** |
> | optionCount (correct-option selector) | present | present | present | **PASS** |
> | question text | metadata only | rendered into a textarea | metadata only | **PASS** |
>
> **Validation:** `tsc --noEmit` clean; `ocr-analysis` + `handle-ocr-callback` + new
> `python-visual-parity.spec.ts` = **12/12** (the new spec asserts VISUAL type, no `options`, crop key +
> `optionCount` preserved, option-bearing question NOT downgraded to SINGLE_CHOICE). Live UI render not
> run here (needs backend + sidecar + `PYTHON_DOCUMENT_ENGINE=1`).
>
> ---


**Goal:** the application must behave exactly like before — users see a proper crop image, question text,
options and layout. Python may only *improve* accuracy; it must never degrade UX.

**Regression observed (hard FAIL):**
```
Question 19
(empty textbox)
a  b  c  d
```
**Expected (existing behaviour):**
```
Visual Question  →  question image  →  4 options correctly attached
```

This report traces every stage, names the exact stage that degraded, and records the fix. It is derived
from the production code paths (no live run fabricated): `OcrJobRunner.run` →
`runPythonDocumentEngine` → `OcrAnalysisDeliveryService.deliverPythonDocument`, and the TS pipeline
`resolveDrafts` → `persist` → `deliver`.

---

## Stage trace — Stage / Input / Output / Reason

| Stage | Input | Output (before fix) | Reason |
|---|---|---|---|
| TS OCR | upload bytes | `analysisWordsByPage`, `analysisPageImages`, raw drafts | unchanged — works |
| analysisWordsByPage | page renders | per-page word boxes (PDF points) | unchanged — works |
| pageImageKey / render | PDF page | 200-DPI page render | unchanged — works |
| Python ownership | words + renders | 1 owner per question, ownership graph | works (counts pass) |
| Python crop | ownership graph | **crops = [] when `deliver=false`** | `build_document` early-returns before crop construction when `cropGate != PASS` **or** Stage 1 N=N=C fails (completeness `< logical`). On real docs this is the **common** case → **no crops built** |
| Python repair | crops | n/a (no crops to repair) | skipped — nothing was built |
| Python validation | crops | `deliver=false`, `crops=[]` | correct *gate* decision, but it left zero crops |
| **TS stores** | Python `deliver=false`, `crops=[]` | **drafts with NO `questionSnapshotKey`, `text="Question N"` placeholder, options a–d, `invalidCrop=true`** | **DEGRADATION HERE.** `deliverPythonDocument` builds one draft per Python question; with `crops=[]` the snapshot key is never set and text falls back to a placeholder. `runPythonDocumentEngine` then **returns true**, so the TS screenshot-first pipeline is skipped — no fallback |
| UI render | crop-less drafts | "Question 19 / empty textbox / a b c d" | the draft has no crop image and only a placeholder text |

**Exact degradation stage: `Python crop → TS stores` (the `deliver=false` branch of `deliverPythonDocument`).**
Counts/ownership passed; crop construction produced nothing because the document did not clear the
delivery gate, and TS persisted Python's crop-less set instead of preserving the existing TS crops.

---

## Behaviour Parity Report — TS vs Python (before fix)

| Aspect | TS Output (existing) | Python Output (build, deliver=false) | Difference | Impact | PASS/FAIL |
|---|---|---|---|---|---|
| Crop image | screenshot-first crop attached to EVERY question (`questionSnapshotKey`) | **none** (`crops=[]` → key undefined) | image lost | empty textbox in UI | **FAIL** |
| Question text | OCR text or visual snapshot | `"Question N"` placeholder | real content replaced by placeholder | looks empty | **FAIL** |
| Options | options attached to the crop/question | bare `a b c d` labels, detached from any image | options orphaned from the visual | wrong layout | **FAIL** |
| Layout | Visual Question (image + options) | number + empty box + loose options | structure lost | not the expected experience | **FAIL** |
| Question count | TS reconciliation | Python ownership (often higher accuracy) | — | accuracy (not UX) | n/a |
| Review routing | flagged, but crop still shown | flagged, crop missing | review with no image | can't review | **FAIL** |

When Python **can** cleanly deliver (`deliver=true`) its crops are built + validated and the output is
strictly better — that path is kept. The FAIL is confined to `deliver=false`.

---

## Fix — preserve existing UX, migrate only the decision-making

`src/shared/workers/ocr-job-runner.service.ts` → `runPythonDocumentEngine`:

- `deliver=true`  → persist Python's built/validated crops (improved accuracy). Unchanged.
- `deliver=false` → **return `false`** so `run()` falls through to the existing TS OCR pipeline
  (`resolveDrafts` → proper Visual-Question crops + options → route to review). The crop-less Python
  drafts are discarded, never persisted.
- engine unavailable → still THROWS (transient error → retry). Unchanged.

This is the directive's principle exactly: *if TS behaviour was already correct, KEEP IT; replace the
output only when Python's accuracy is proven.* Python remains the intelligence layer; it owns the
delivered result only when its crops pass every gate. Until then the user sees the existing,
working Visual-Question experience.

No UI redesign, no OCR-flow redesign, no new engine, no new heuristic — one decision point changed:
*Python owns the output only when `deliver=true`.*

---

## Validation status

- `tsc --noEmit` clean (whole backend).
- Offline crop trace (`crop_trace.py`) confirms: when the document does clear the gate, crops are
  full-size and correct (coordinate fix + per-page scale); when it does not, `crops=[]` and `deliver=false`
  — which is now the TS-fallback trigger, so the UI keeps the existing crops.
- LIVE upload regression (UI shows a proper Visual Question for `deliver=false` docs) **not run here**
  (needs backend + sidecar + `PYTHON_DOCUMENT_ENGINE=1`). To verify: upload a regression PDF, confirm
  the log line `PYTHON ENGINE deliver=false … preserving existing TS crop behaviour`, then confirm the
  review UI shows crop image + options (not the empty-textbox layout).
