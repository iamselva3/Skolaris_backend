# Enterprise Document Intelligence Engine — requirement status (code-grounded)

Status of every requirement in the "build a robust enterprise engine, not PDF-by-PDF" directive,
mapped to the ACTUAL code. No "Unknown": each row is DONE / PARTIAL / MISSING with the file and the
precise gap. Scope note: the structure-engine + delivery + crop files are under ACTIVE concurrent
editing this session; this status reflects the tree as validated here, and flags where new code would
collide so work is sequenced, not duplicated.

## Headline result (this run)
Running the universal trace on a regression document end-to-end (`crop_trace.py`):
**logical=50, ownership=50, complete=50, crop=50, delivered=50, deliver=true, Stage 1 + Stage 2 N=N=C
PASS, 0 missing / duplicate / Q0 / impossible, 0 boundary / detached / foreign-ownership / visual
issues → VERDICT PASS.** Two consecutive runs were **byte-identical** (determinism proven). So on a
clean digital paper the engine now delivers *the existing UX + higher accuracy*, which is the goal.

---

## Requirement matrix

| # | Requirement | Status | Evidence / Gap |
|---|---|---|---|
| 1 | Python = primary intelligence for ALL PDFs; TS = OCR tokens + infra | **DONE (digital), PARTIAL (scanned)** | `document_engine.process_document`, `router.ocr_page`. Scanned/handwritten DEGRADE (KEEP PIXELS) until PaddleOCR/TrOCR wheels install (blocked on py3.13). |
| 2 | Every upload auto-cleanup first; no "Original vs Enhanced" choice | **PARTIAL** | `cleanup-orchestrator.startBackgroundCleanup` runs Python `/cleanup` but OFF the critical path (background, overwrites object for *subsequent* runs). It does NOT run *before* `/process-document`. The "Original/Enhanced" choice is a FRONTEND surface (separate repo) — not removed here. GAP: make Python cleanup a synchronous FIRST stage inside the document engine, not a background overwrite. |
| 3 | Remove bg/watermark/header/footer/border/repeated elements safely; uncertain → keep pixels | **PARTIAL** | Header/footer/page-number repeats: `repeated_chrome.detect_chrome` (excluded from markers, KEEP PIXELS, never deleted) ✓. Background/watermark/divider: `crop-display-clean.ts` + Python `/cleanup` (CV) — but these live on the TS display path / background, not inside the Python build. GAP: unify removals into the Python engine + surface counts. |
| 4 | Repeated headers (e.g. "SK Learning") never affect ownership/numbering/continuation/crop | **DONE (markers), PARTIAL (crop)** | `detect_chrome` excludes repeated edge tokens from markers so they can't become false question numbers ✓. GAP: chrome is not yet subtracted from the CROP region (a header band inside a crop is kept as pixels — acceptable per KEEP-PIXELS, but could be whitened). |
| 5 | Never "Question N + empty textbox + detached a/b/c/d"; UI = existing Visual Question | **DONE** | Fixed both halves: deliver=false → TS fallback; deliver=true → VISUAL draft (crop image is the source of truth, no `options` array, no placeholder text). See `BEHAVIOUR_PARITY_REPORT.md`, spec `python-visual-parity.spec.ts` 12/12. |
| 6 | Crop must contain number/text/all options/continuations/diagrams/graphs/equations/tables/chem/labels; no cuts/detached | **DONE (token+CV), validated** | `crop_engine.repair_crop` (anchor-bounded, edge-cut detect+expand), `ownership_completeness` gate, `visual_detectors`. Trace shows 0 boundary/detached/visual issues on the regression doc. |
| 7 | Coordinate spaces must always align (the fragment bug) | **DONE** | `coordinate_validator.validate` (per-page scale, aspect, cross-page, on-render fit) gates `document_builder`; misalignment → KEEP PIXELS → review. Tests 6/6. |
| 8 | Stronger question-number engine (badges/circles/boxes/handwritten/decorative); multi-signal | **PARTIAL** | EXISTS: `marker_reconciler` (margin anchor + sequence reconstruct + gap recovery from demoted candidates), `ownership_graph._recover_from_orphan_blocks` (badge/numberless → recover from an orphan OPTION block with a real stem) + `_gap_fill_numbers`. GAP: a true multi-signal scorer (sequence+ownership+option+visual+page+neighbor evidence COMBINED) is not a single module; badge handwritten/decorative detection is structural-only (no glyph-shape model). NOTE: `_split_badge_absorbed` is DELIBERATELY DISABLED (over-split a clean paper 50→52) — re-enable only behind a real badged-scan fixture. |
| 9 | Recover before declaring missing; gap (Q2,Q4 → Q3?) investigated; "stem+4 options, no number" recovered | **DONE (mechanism), needs scanned validation** | Gap recovery: `marker_reconciler` step 3 (fills accepted-range gaps from demoted candidates). Stem+options-no-number: `_recover_from_orphan_blocks` + `_gap_fill_numbers`. Missing numbers carry an explanation, never silently skipped (`questionCount.missingQuestions`). |
| 10 | Global page analysis; pages not separators; cross-page + cross-column ownership; whitespace never a separator; 1Q=1owner=1crop | **DONE** | `merge_detector` (10 cases) + `cross_page_detector` + `cross_column_detector` + `continuation_detector`; segments cut only at real markers (whitespace/page-end are not cuts). `integrity_gate` one-owner invariant. |
| 11 | Deterministic output (same PDF twice → identical) | **DONE (proven)** | Two consecutive full runs byte-identical (report + crop md5). Structure engine is pure (no time/random; sets used only for membership/len/min-max). |
| 12 | Investigate pdf-lib / preprocessors interfering; make secondary/fallback | **DONE (investigation) — see below** | pdf-lib is used by `pdf-reflow.ts` (gated `OCR_PREPROCESS_REFLOW`, default OFF) and `document-enhancement/pdf-lib-enhancer.ts`. Findings + recommendation below. |
| 13 | Per-upload validation report (18 fields) | **DONE** | `crop_trace.py` BUILD VALIDATION REPORT now prints: page count, logical, ownership, complete, crop, delivered, missing numbers, recovered numbers, duplicates, Q0, impossible, cross-page, cross-column, header/footer artifacts, background/watermark (upstream), detached, visual issues, Stage1/2, PASS/FAIL. |
| 14 | No PDF-centric rules; never silently deliver wrong; never sacrifice crop quality for counts | **DONE (principle enforced)** | All thresholds are document-derived ratios; every gate routes to review rather than deliver-wrong; crop gate is independent of the count gate. |

---

## pdf-lib / preprocessor interference (requirement 12)

**Where pdf-lib runs:**
- `src/modules/ocr-preprocess/pdf-reflow.ts` — column reflow, rebuilds the PDF and **overwrites the
  stored object** (`putObject(storageKey, reflow.pdf)`). Gated `OCR_PREPROCESS_REFLOW` (**default OFF**).
- `src/modules/document-enhancement/pdf-lib-enhancer.ts` — PRIMARY decorative-content removal for
  DIGITAL PDFs (Phase 2). Not wired into the live `/process-document` critical path.
- `cleanup-orchestrator.startBackgroundCleanup` — not pdf-lib, but **overwrites the stored object** with
  the Python `/cleanup` output "for subsequent runs."

**Does it interfere with Python today?** In the `PYTHON_DOCUMENT_ENGINE` path, `runPythonDocumentEngine`
reads the **original** `storageKey` and returns before reflow/background-cleanup run, so the FIRST run is
not altered. **Latent risk:** any preprocessor that `putObject(storageKey, …)` mutates the canonical
upload, so a **retry/resume reads different bytes than the first attempt** — a determinism hole and a
cleanup that competes with Python's own.

**Recommendation (small, safe, NOT applied — flagged to avoid colliding with the concurrent cleanup
edits):** when `PYTHON_DOCUMENT_ENGINE` owns the upload, the preprocessors that rewrite `storageKey`
(reflow, background cleanup) must be **secondary/fallback only** — either skipped, or made to write a
DERIVED key (e.g. `${storageKey}.cleaned`) that the TS-fallback path reads, leaving the canonical
upload immutable so Python always sees identical original bytes. This makes Python cleanup primary and
guarantees determinism across retries.

---

## What to do next (sequenced, non-colliding)

1. **Scanned/handwritten** (req 1): install PaddleOCR/TrOCR (py3.13 wheel pin), validate the router on
   scanned docs — the largest accuracy gap; everything else already passes on digital.
2. **Cleanup as a first engine stage** (req 2/3): move Python `/cleanup` to run synchronously inside the
   document engine before OCR, surface bg/watermark/header/footer removal counts into the report.
3. **Multi-signal number scorer** (req 8): consolidate the existing recovery signals into one scored
   module; gate any new badge/decorative recovery behind a real badged-scan fixture (avoid the 50→52
   over-split regression).
4. **Immutable canonical upload** (req 12): make TS preprocessors write derived keys (above).

None of 1–4 requires touching the files the concurrent crop/visual session is editing.
