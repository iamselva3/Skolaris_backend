# OCR Family Registry

Canonical source of truth for SKOLARIS OCR layout-handling. This document — **not** any
agent memory or index — owns the catalogue of OCR layout families: what is solved and
frozen, and what is deferred pending real sample PDFs.

> Architecture-of-record (FROZEN): `docs/OCR_ENTERPRISE_ARCHITECTURE.md` — the wrap-around
> pipeline (Page Analyzer → independent Pattern Detectors → existing OCR → Question Integrity
> Validator → Review Queue) and the 8 frozen detectors. This registry owns the per-family
> evidence; that doc owns the pipeline + detector contract.

**Standing rules (apply to every entry):**

- **Pattern-based only.** Every rule must work on unseen Indian NEET/JEE papers.
- **Never PDF-specific.** No literal values, no per-paper conditions.
- **Do not reopen frozen families** (Section 1) without a new explicit authorization.
- **180/180 is the regression standard.** The RE NEET PST baseline must never decrease.
- **Question quality > question count.** Never inflate the count; prefer a clean no-op when uncertain.

**Regression baselines (all 5, fixed):** RE NEET PST · Biology · Biology_Cell · AD 2601 Q · PHYCHE.

---

## Operating protocol (PERMANENT)

**This document is the ONLY source of truth for OCR layout handling.** Never assume SKOLARIS
currently supports all Indian NEET/JEE paper designs — state coverage honestly from Section 3.

**Before any OCR work:**
1. Check whether the problem belongs to a **frozen family** (Section 1).
2. If frozen → **do not reopen it.**
3. If it is a **new layout** → **classify it first** (which family / a genuinely new one) before anything else.

**Core rules:**
- Never create PDF-specific fixes. Never create institute-specific fixes. **Everything must be pattern-based.**
- **Question quality > question count.**
- **Prefer NO-OP over unsafe changes.**
- **180/180 (RE NEET PST) is the regression standard** and must never decrease.

**Do not build anything for "Not Validated" families.** Reopen a family ONLY when **≥3 real PDFs
exist for that family** OR **a new unseen layout appears.**

**Before proposing any code (in order):** 1. Investigate → 2. Classify → 3. Show evidence →
4. Show risks → 5. Show the legal seam → 6. Then propose implementation.

**NEVER modify (without explicit per-instance authorization):**
- `OcrJobRunner`
- `CompleteUploadUseCase`
- `HandleOcrCallbackUseCase`
- `src/shared/ocr-engine/*`
- Any frozen OCR family (Section 1)

Legal seams for any new work: the pre-OCR `ocr-preprocess` layer, or a new post-OCR associator —
never the frozen engine.

**Documentation hygiene:** this registry is the ONLY source of truth. Memory/agent notes may
contain **pointers only** — never duplicate OCR families, rules, coverage, validation results, or
risk analysis into memory. **Session 2 is a research/validation session only — do not implement code
unless explicitly requested.**

---

## Section 1 — Solved (Frozen)

### 1.1 Multi-column reflow
- **Root cause:** true side-by-side multi-column pages were over-split by the segmenter into
  narrow slices that cut questions mid-line and dropped options.
- **Generalized rule:** a pre-OCR preprocess layer (`src/modules/ocr-preprocess`,
  `POST /ocr-preprocess/:uploadId`) detects a central whitespace gutter via vertical
  ink-projection and reflows the page to single-column **only** when all gates pass:
  `confidence ≥ 0.85`, `minColumnInk ≥ 0.08` (dense columns), `crossingFraction ≤ 0.20`
  (clean river). A ruled divider or sparse/low-confidence layout → no-op. Wide bands where
  ink crosses the gutter are kept full-width. The OCR engine is untouched.
- **Validation results:** AD 2601 Q reflows 15/19 pages, incomplete-crop suspects 48 → 33;
  RE NEET PST / Biology / Biology_Cell / PHYCHE reflow 0 pages → byte-identical (no-op).

### 1.2 Numeric units / option values
- **Root cause:** a number fused to a letter (Svedberg `70S`, voltage `25V`, energy `85eV`,
  mass `15g`) was promoted to a question-number marker by `NUM_GLUED_RE`, spawning phantom
  columns/crops and shattering questions.
- **Generalized rule:** predicate `isContentNumberToken` in `src/shared/ocr-engine/visual-segment.ts`
  — `UNIT_VALUE_RE = /^\d{1,3}[A-Za-z]{1,3}(?![A-Za-z])/` demotes a number fused to a **closed
  1–3 letter** run. A number fused to a real **word** (`150Match`, ≥4 letters) is kept as a
  legitimate glued marker. Applied at both marker-promotion paths.
- **Validation results:** Biology_Cell 104 → 100 (page 1–2 reconstructed, Q5 whole with 4
  options, false 2-column split collapsed); AD 154 → 151 (unit phantoms removed); baselines
  unchanged.

### 1.3 Chemistry locants
- **Root cause:** chemistry locants/ranges (`2,3-`, `3,4,4-`, `0,4-`) were promoted to markers —
  `NUM_DOT_RE` accepts a comma terminator (added to recover OCR-misread `"43." → "43,"`), and
  OCR also space-splits a locant into `2,` + `3-`.
- **Generalized rule (same predicate family):** `LOCANT_RE = /^\d{1,3}[,\-]\d/` (glued locant)
  plus the adjacent-token extension `isSplitLocantHead` — a `N,` token whose immediately-adjacent
  right neighbour matches `/^\d{1,3}[,\-]/` (split locant `2,` + `3-`). A real comma-terminated
  question (`44,` followed by a word) is **not** demoted.
- **Validation results:** PHYCHE 53 → 50 (locant phantoms on p8/p10 removed and their false
  2-column splits collapsed); baselines unchanged. One residual split-locant on PHYCHE p17
  (`0, 4-formly`) is handled as a human **review candidate**, not an engine fix.

### 1.4 Gutter-crossing protection
- **Root cause:** diagrams, tables, graphs, circuits, and biological figures span the gutter and
  must never be split as if they were separate columns.
- **Generalized rule:** the reflow uses a page-level `crossingFraction` gate (≤ 0.20) plus
  band-level classification — any band where ink crosses the gutter window is kept **full-width**.
  High page-level crossing → the whole page is a no-op (kept full-width).
- **Validation results:** AD's clean columns cross only ~2–4% of rows (still reflow); pages with
  wide crossing content stay full-width; no reference regressed.

### 1.5 Match-the-following
- **Root cause:** a List I / List II structure resembles stem + options and could be mis-split or
  merged incorrectly.
- **Generalized rule:** the engine classifies such blocks (`classifyBlock === MATCH_THE_FOLLOWING`)
  and `isCompleteBlock` requires a real stem, so List II is never treated as A/B/C/D options.
- **Validation results:** RE NEET PST / Biology match questions retained correctly; baselines
  unchanged. (Pre-existing engine behaviour; documented here for completeness.)

---

## Section 2 — Backlog (Blocked)

> **Status: BLOCKED. Pending ≥ 3 real PDFs per family.** No validated samples exist in the current
> regression PDFs for these families (`scripts/diag-split.ts` / `diag-stemopt.ts` found 0 positives).
> They are **not** implemented. Do not introduce an associator or any hypothetical logic until real
> positive samples are supplied. The design decisions below are the design-of-record for when samples
> arrive — they are not a license to build.

### Shared design rules (apply to every family below)
- **Engine remains frozen.** No edits to the OCR engine or the do-not-touch files.
- **Post-OCR associator only.** Any solution lives in a new post-OCR layer that consumes region
  drafts read-only and only *groups* regions — never re-segments, never edits `visual-segment.ts`.
- **Never PDF-specific.** Pattern-based only; no literal values, no per-paper or per-institute rules.
- **Review-reversible merges only.** Merges are surfaced as suggestions and are reversible at review;
  orphans are never silently deleted.
- **Question quality > count.** Prefer a clean no-op over an uncertain merge.

### Hard safety rules (a merge is allowed only when ALL hold)
- **No valid next-question number** appears between the two candidate regions.
- The **candidate (continuation) region has no question number** of its own.
- For horizontal pairing, the **entire right column has no question markers** (the AD 2-column trap).
- **Match-the-following is protected** (`classifyBlock === MATCH_THE_FOLLOWING` is never split/merged).
- **Diagrams / tables / graphs (gutter-crossing bands) are protected** and kept whole.

### 2.1 Stem top → options bottom
- **Signature:** an orphan region (starts with A/B/C/D option grammar, no question number, no stem
  sentence) directly below a stem region in the **same column**, vertical gap small.
- **Risks:** wrong vertical pairing when stem heights vary; merging could hide a real question whose
  number was merely missed; must never emit an option-only region as its own question.
- **Proposed seam:** post-OCR associator. Merge the orphan upward to the same-column stem only when
  all hard safety rules hold; otherwise no-op.
- **Validation requirements:** ≥ 3 real PDFs (not screenshots); end-to-end OCR validation; regression
  against all 5 baselines — AD → 0 false merges, RE NEET PST → 180/180, others not degraded.

### 2.2 Stem left → options right
- **Signature:** a marker-bearing stem in the left column whose same row-band right half holds an
  option-grammar region that carries **no question marker of its own**.
- **Risks:** **highest risk** — spatially almost identical to a true 2-column paper (AD). The only
  safe discriminator is "the right column has **no** question markers"; misclassifying AD's two
  independent columns as stem+option would merge separate questions and break 180/180.
  Match-the-following is a secondary look-alike.
- **Proposed seam:** post-OCR associator with the strictest gate — require the whole right column to
  be marker-free before associating; any doubt → no-op (keep full-width).
- **Validation requirements:** ≥ 3 real PDFs; end-to-end OCR; AD → 0 false merges; RE NEET PST →
  180/180; others not degraded.

### 2.3 Cross-page continuation
- **Signature:** an option-starved or sentence-incomplete tail region at the bottom of page N, and a
  number-less head region at the top of page N+1.
- **Risks:** vertical continuity breaks at the page boundary; high chance of associating unrelated
  content (e.g. a section header read as continuation).
- **Proposed seam:** post-OCR associator that stitches tail→head as a **review-surfaced suggestion**
  (not a silent merge) only when the hard safety rules hold and no header sits between.
- **Validation requirements:** ≥ 3 real PDFs spanning a page boundary; end-to-end OCR; AD → 0 false
  merges; RE NEET PST → 180/180; others not degraded.

### 2.4 Handwritten numbers
- **Signature:** a content-complete question (stem + 4 options) whose number is handwritten / circled
  / stamped / in the left margin — a glyph the printed-marker detector never matches.
- **Risks:** handwritten marks are not robustly recognised as markers (printed-only today); numbers
  are **hints only**, never mandatory — a rule must never *require* a number.
- **Proposed seam:** NOT an association or preprocess problem — reflow is already number-agnostic.
  Treat content-completeness as the boundary and capture the handwritten number as a **review hint**,
  never a segmentation gate. Improving marker *recognition* itself would need separate explicit
  engine authorization (out of scope under the freeze).
- **Validation requirements:** ≥ 3 real PDFs each for pen/pencil, circled, stamped, left-margin;
  end-to-end OCR; regression against all 5 baselines; 180/180 unchanged.

---

### Reopening a backlog family
A backlog family moves to Section 1 only after: (1) **≥ 3 real PDFs** for that layout, (2)
**end-to-end OCR validation** on them, and (3) **regression validation against all 5 baselines**
with a **pattern-based** solution (no PDF-specific conditions). **180/180 (RE NEET PST) remains the
regression standard and must never decrease.** Read-only probes to confirm a layout actually
manifests before any design: `scripts/diag-split.ts`, `scripts/diag-stemopt.ts`,
`scripts/diag-markers.ts`, `scripts/diag-count.ts`.

---

## Section 3 — Coverage assessment (FROZEN — Session 2 PAUSED)

Accepted coverage status of each layout family against the 5 regression baselines
(RE NEET PST · Biology · Biology_Cell · AD 2601 Q · PHYCHE). No percentages. No claim of
universal NEET/JEE support. "Not Validated" means **no validated sample exists in the 5
baselines** — it is **not** evidence of failure; coverage is unmeasured.

| Layout family | Status | Evidence | Risks | Blocking factors |
|---|---|---|---|---|
| **Single-column** | **Validated** | RE NEET PST 180/180; Biology 85=85; Biology_Cell→100 (p1–2 reconstructed); PHYCHE→50 | 1 residual PHYCHE p17 phantom (review candidate) | None |
| **Match-the-following** | **Validated** | RE NEET PST / Biology match questions retained (`classifyBlock===MATCH_THE_FOLLOWING` + `isCompleteBlock`) | List II mis-split if classifier misses; stem+options look-alike | Few samples (2 baselines) |
| **True multi-column** | **Partially Validated** | AD 2601 Q only: reflow 15/19 pages; suspects 48→33; count 154→151 | 4 pages don't reflow; 33 suspects remain | Single sample (AD); ≥3 true-2-col PDFs needed |
| **Diagrams / tables / graphs** | **Partially Validated** | Gutter-crossing protection (≤0.20) keeps crossing bands full-width; AD diagrams intact (cross 2–4%) | Kept-whole ≠ tightly cropped; crop tightness unmeasured | No figure-crop-quality metric |
| **Image-heavy** | **Partially Validated** | Indirect: Biology/Biology_Cell/AD figure-bearing questions kept whole; crop-trim layer; Biology_Cell 2×2 grid reconstructed→100 | Crop accuracy on mostly-image questions unvalidated by count; option-grid edge cases | No dedicated image-heavy metric |
| **Stem top → options bottom** | **Not Validated** | No validated samples available (0 orphan-option regions) | Not built | ≥3 real PDFs |
| **Stem left → options right** | **Not Validated** | No validated samples available (0 option-starved stems) | AD false-merge trap if built blind | ≥3 real PDFs |
| **Cross-page continuation** | **Not Validated** | No validated samples available (0 positives) | Not built | ≥3 real PDFs |
| **Handwritten numbers** | **Not Validated** | No validated samples available (0 handwritten markers; printed-marker only) | Not built | ≥3 real PDFs; recognition is engine-side (frozen) |
| **Assertion / Reason** | **Not Validated** | No validated samples available in the 5 baselines | Coverage unmeasured | A/R PDF needed |
| **Paragraph** | **Not Validated** | No validated samples available in the 5 baselines | Shared-stem grouping unmeasured | Paragraph-set PDF needed |
| **Matrix** | **Not Validated** | No validated samples available in the 5 baselines | Resembles match/diagram look-alikes; unverified | Matrix PDF needed |

**Conclusion:** Current OCR baseline is validated against the regression set. Universal Indian
exam support is still under validation. **180/180 (RE NEET PST) remains the regression standard.**

**Session 2 status: PAUSED.** Do not refine this assessment further. Reopen only when **≥3 real
PDFs arrive** for a backlog family **OR** a new unseen layout appears. No implementation, no
reopening of frozen OCR work.
