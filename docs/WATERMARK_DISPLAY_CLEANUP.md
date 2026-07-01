# Display-layer watermark cleanup — validated baseline

Removes the publisher watermark (e.g. the "Aakash" logo + diagonal banner + CC‑315
codes) from the **displayed question crops** only. It runs in `cleanCropForDisplay`
([src/shared/ocr-engine/crop-display-clean.ts](../src/shared/ocr-engine/crop-display-clean.ts)),
**after** OCR, segmentation, marker/number/sequence/gap‑recovery and draft generation.

## Why it cannot affect OCR

The cleaned crop is only written to storage
([visual-segment.ts:1247](../src/shared/ocr-engine/visual-segment.ts#L1247) `putObject`).
Every draft field — `questionNumber`, `sourceCoordinates {x0,y0,x1,y1}`,
`optionCount`, `confidence` — is derived from the OCR word boxes, never from the
cleaned image. The `OCR_DISPLAY_*` flags are referenced **only** in
`crop-display-clean.ts`; `ocr-engine.ts` / `visual-segment.ts` read none of them.
So display cleanup is structurally incapable of changing detection.

## Display-only cleanup flags (all DEFAULT ON, env‑disableable)

| Flag | Default | Disable with | What it removes |
|---|---|---|---|
| `OCR_DISPLAY_BG_TRAIL` | **on** | `OCR_DISPLAY_BG_TRAIL=false` | faint watermark trail in **empty background** |
| `OCR_DISPLAY_WM_PERSISTENT_CORE` | **on** | `OCR_DISPLAY_WM_PERSISTENT_CORE=false` | the **dark logo / diagonal text** inside the mask |
| `OCR_DISPLAY_HSEP_CLEANUP` | **on** | `OCR_DISPLAY_HSEP_CLEANUP=false` | the **PDF page-end / footer horizontal separator rule** (Pass 4) |
| `OCR_DISPLAY_CROP_TRIM` | **on** | `OCR_DISPLAY_CROP_TRIM=false` | surrounding **blank margins + trailing footer chrome** (word-box-anchored trim, after the passes above) |

The only signal used to separate watermark from content is the **cross‑page flat
field** (a watermark repeats at the same spot on every page; question content is
unique to its page). No darkness / density / contrast / thickness heuristic is used —
that is what caused earlier diagram regressions (Q108).

**`BG_TRAIL`** — a medium‑grey pixel counts as protected "ink" only if the flat field
says it is content (genuinely dark, or flat‑bright/unique). A *persistent* medium‑grey
pixel stops self‑protecting, so empty‑background trail clears. Unique content of any
intensity keeps its bright flat ⇒ still protected.

**`PERSISTENT_CORE`** — inside the large‑watermark mask, the absolute dark guards
(`CORE_DARK`, `WHITE_FLOOR`) are dropped so a dark watermark stroke can be whitened —
but only where the flat field confirms persistence. Unique content (flat‑bright, guard
E) and content‑over‑watermark (darker‑than‑background, guard D) are still protected.
It is **gated to the mask** (`persistentCore && mreg != null`): with no cross‑page
mask there is no consensus, so the conservative dark guards stay.

## Horizontal page-separator cleanup (`OCR_DISPLAY_HSEP_CLEANUP`, Pass 4)

The horizontal mirror of the vertical-divider Pass 3. It **whitens in place** (never
crops) the PDF page-end / footer separator rule that the segmentation crop drags in.
It runs *inside* `cleanCropForDisplay` (before the crop trim), so a whitened line can't
anchor the trim region.

**What is removed:** a horizontal dark line that is (a) **full-width** (≥60% of the
crop width), (b) **persistent across pages**, and (c) **vertically isolated** (blank
band above/below).

**What is protected (never removed):**
- table borders, match-the-column grids, graph axes, formula rules, option underlines,
  diagram lines — they are **unique to their page** ⇒ flat-bright ⇒ kept;
- any line with **ink above/below it** (content-adjacent) ⇒ kept;
- anything uncertain ⇒ kept.

**Persistence is tested at ROW level, not per pixel.** A thin 2px rule is averaged to
grey in the low-res (700px) cross-page flat field, so a per-pixel "darker-than-bg"
guard (Pass 3) wrongly keeps it. Instead Pass 4 requires the flat field to **dip** at
the line row vs ±`HSEP_FLAT_GAP`(6)px by ≥ `HSEP_DIP`(14) — a persistent horizontal
dark band. A unique rule shows no dip and is kept. Tunables: `OCR_DISPLAY_HSEP_DARK=150`,
`OCR_DISPLAY_HSEP_COVERAGE=0.6`, `OCR_DISPLAY_HSEP_ISOLATE=10`, `OCR_DISPLAY_HSEP_FLAT_GAP=6`,
`OCR_DISPLAY_HSEP_DIP=14`.

**Validation** (`scripts/diag-hsep-validate.ts`):
- **RE NEET PST 3 (25pp):** OCR identity off-vs-on = **180/180, 0 per-draft diffs**
  (number/coords/options/confidence/count). 10 full-width horizontal lines flagged →
  **5 removed (all genuine page-separators) + 5 kept (unique diagram content: Q44
  field-lines, Q151 DNA strand)**. Visual: Q6 separator gone + diagram/options intact;
  Q180 table borders intact; Q108 Structure-X diagram intact. **0 content removed.**
- **Second template (one-mark, 21pp, watermark-heavy):** **198/198, 0 diffs, 0 removed**
  — conservative when persistence can't be confirmed (heavy watermark flattens the dip),
  i.e. it under-removes rather than risk content. No regression with `BG_TRAIL` /
  `PERSISTENT_CORE` / the crop trim (all on in both runs; 0 draft diffs).

## Validation (real RE NEET PST 3 paper, 25 pages)

Harnesses: `scripts/diag-trail-compare.ts`, `diag-pcore-validate.ts`,
`diag-pcore-ocr-identity.ts`, `diag-guard-breakdown.ts`, `diag-mask-coverage.ts`.

**Content safety (per‑pixel, engine‑exact luma):**

| Pass | watermark px removed | content pixels affected |
|---|--:|---|
| `BG_TRAIL` | 9,972 | **0** (dark‑ink 0, halo 0, flat‑bright 0) |
| `PERSISTENT_CORE` | 81,984 | **0** (flat‑bright 0, darker‑than‑bg 0, outside‑mask 0) |

Total watermark‑ink footprint 449,687 px → **~95.1% removed, 22,049 px residual.**
Visually confirmed on physics diagrams (circuit, galvanometer ring), chemical
structures, match‑the‑column tables, biology figures and the **Q108 "Structure X"
diagram** — removal lands only on the watermark; no content pixel touched.

**OCR identity** (segmentation run twice, flags off vs on, with display flat+mask so
the flags actually execute):

| metric | off | on |
|---|--:|--:|
| draft count | 180 | 180 |
| detected | 180 | 180 |
| coverage | 99% | 99% |
| per‑draft field diffs | — | **0** |

**180/180 preserved. OCR differences = 0.**

**Residual 22,049 px is the safe floor** — 61% is watermark overlapping question
content (kept by design), 38% sub‑pixel mask‑edge residue, 0.8% page‑code dots. Mask
dilation/closing recovers ≤0.3% (all content‑adjacent) while sweeping 0.5–3.6M content
pixels under the mask — rejected. This is the maximum safe removal.

## Rollback

- Disable one feature (no deploy needed — read at request time):
  `OCR_DISPLAY_BG_TRAIL=false`, `OCR_DISPLAY_WM_PERSISTENT_CORE=false`,
  **`OCR_DISPLAY_HSEP_CLEANUP=false`** (horizontal separator), or
  `OCR_DISPLAY_CROP_TRIM=false` (crop trim).
- Disable all display cleanup: `OCR_DISPLAY_WATERMARK_CLEANUP=false`.
- Full code revert: revert the commit touching `crop-display-clean.ts` — display‑only,
  no migration, no OCR/segmentation impact.
