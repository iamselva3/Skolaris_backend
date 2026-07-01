# Structural Intelligence Engine

Python understands **document structure** — it is **not OCR, not AI, not business
logic**. It consumes the OCR tokens + page renders that the (frozen) TS OCR engine
already produced, reasons about structure (question ownership, merges, sequence, page
role), and returns a **proposal**. TS validates the proposal and is the only authority
that persists.

> **Golden rule:** Python proposes → TS validates → persist.
> Python never persists, never crops, never splits, never guesses silently. Uncertain
> ownership → route to review.

Runs inside the **existing** `ocr-cleanup` sidecar (`localhost:8002`) on the new route
`POST /analyze-document`. No new service / port / container.

## Contract

```
POST /analyze-document
{
  "documentId": "…",
  "pages": [
    { "index": 1, "width": 650, "height": 900, "pageImageKey": null,
      "words":   [ { "text": "1.", "x0": .., "y0": .., "x1": .., "y1": .., "conf": .. }, … ],
      "markers": [ { "num": 1, "x0": .., "y0": .., "x1": .., "y1": .., "punct": "." }, … ]  // optional
    }
  ]
}
→ DocumentAnalysis  (see models.py — pageClasses, questions[ownership+merges+options+
   completeness+confidence], orphans, sequence, recommendation)
```

`markers` is optional: when absent, Python derives question-number markers from the
word **tokens** (token parsing, not OCR — see `marker_extractor.py`).

## Pipeline (pipeline.py)

```
page → structural analysis (geometry) → page role (page_classifier)
     → starts (question_start_detector) → segments (question_end_detector)
     → merge detection (continuation + cross_column + cross_page → merge_detector)
     → ownership graph (every element gets one owner; unowned → orphan/review)
     → option ownership (option_owner_detector)
     → sequence validation (sequence_validator)
     → completeness (crop_completeness_validator) → review routing (review_router)
     → internal consistency + recommendation (validator)
     → confidence (confidence_engine)
     → PROPOSAL  (TS validates → persists)
```

## No tuning knobs

Every threshold derives from the document's own geometry (median glyph height +
whitespace projections). There are **no** `BACKGROUND_THRESHOLD` / `HEADER_HEIGHT` /
`DIVIDER_X` / env tunables, and no hardcoded PDF/institute names or coordinates. The
few constants are universal structural definitions (e.g. "2× median line-height = clear
left space"; "an MCQ option set is 4 labels").

## Tests

`python tests/test_structure_engine.py` (stdlib only — no cv2/fastapi needed). Covers
each module + the merge cases (cross-column, cross-page), sequence anomalies, page
classification, marker derivation, and safe-on-garbage. Node side:
`structure-analyze-http.spec.ts`.

## Architectural constraints (enforced)

1. **Proposal-only.** Python never re-crops / splits / merges crops / renumbers /
   deletes / persists. It returns data; TS validates and persists. The Node seam is
   strictly additive — it can only ADD a review flag, never re-crop/remove/relabel.
2. **Ownership graph = source of truth (not numbers).** Question identity is its
   ownership group (position), never its number; numbers only feed advisory sequence
   checks. Every element belongs to exactly one owner — one question→two owners and
   two questions→one owner are impossible by construction and re-checked by the
   integrity gate (`integrity_gate.py`).
3. **N=N=C gate.** Python emits `integrity` (logical / owned / complete counts +
   ownership violations + `status`). TS adds the delivered leg: logical == delivered
   == complete; ANY mismatch or a Python STOP → the whole document routes to review and
   is NOT delivered as clean (`deliverable=false`).
4. **Decision matrix (Python = PRIMARY intelligence, TS = SAFETY AUTHORITY).** Every
   question carries `confidencePct` + `tier` naming the validation level TS applies —
   Python never auto-accepts on its own:
   - `>= 98` → **TS_LIGHTWEIGHT** (TS lightweight validation → accept)
   - `95–97` → **TS_FULL** (TS full validation → accept or review)
   - `< 95`  → **REVIEW**
   Python⇄TS disagreement (e.g. logicalN ≠ delivered) and N=N=C failure also force REVIEW.
   Never silently choose one side. Python may be PRIMARY for ownership — NEVER for
   persistence (`TS extracts → Python reasons → TS validates → TS persists`).

   **Promotion is PER RESPONSIBILITY (never global)** — declared in `promotion.py`, emitted
   as `promotion` in the proposal. PROMOTED (Python primary): ownership graph, merge /
   continuation / cross-column / cross-page / whitespace ownership, orphan / broken-option /
   incomplete-crop detection, confidence scoring, diagram/graph/table/equation/chem
   ownership, background removal. NOT_PROMOTED (Python suggests, TS decides): MCQ /
   answer-key / correction-list / appendix / numbering validation, business rules. And
   `persistence` is permanently NOT_PROMOTED.
5. **ONE intelligence engine = Python. TS = platform / infrastructure (FROZEN).**
   `Upload → TS OCR extraction → Python intelligence engine → ownership graph →
   question lifecycle → N=N=C → TS persistence.` There is no second ownership engine:
   TS no longer re-derives document structure.
   - **The Python engine OWNS** (source of truth): background / watermark / header /
     footer / divider / scanner-noise removal; question start / end / continuation / merge
     detection; cross-column + cross-page ownership; the ownership graph; duplicate /
     Question-0 / impossible-sequence / orphan-option / broken-option / incomplete-crop /
     invalid-crop detection; diagram / graph / table / equation / chemical-structure /
     question+option ownership; complete-question validation; N=N and N=N=C counting.
   - **Python may only SUGGEST** (semantic *candidates*, never decisions): answer-key,
     correction-list, appendix, MCQ, numbering-anomaly — `candidate=true`, hard-capped below
     the auto-accept tier (`SEMANTIC_LABEL_MAX = 0.94`), confidence always < 100.
   - **TS keeps** (platform / business): OCR extraction, API, Redis, BullMQ, Prisma, storage,
     auth, business rules, answer-key / MCQ / numbering validation, persistence, review
     routing. TS persists; **Python never touches the database**.
   - **Uncertainty rule (golden):** Python uncertain OR N=N=C fails → review → do NOT
     persist / deliver. Never silently deliver incorrect output. The authority split is in
     `promotion.py` (emitted as `promotion`). This boundary is frozen.

## Phase status

- **Phase 1 (DONE):** geometry/token spine + all 10 merge cases + sequence + page
  roles + ownership graph + completeness + confidence + the `/analyze-document` route
  + the Node client + a **gated, strictly-additive** delivery seam
  (`STRUCTURE_ANALYZE_ENABLED`, default OFF — can only ADD a review flag, never
  re-crop/remove/relabel).
- **Phase 2 (NEXT):** CV detectors over the page render (diagram / graph / table /
  equation / chemical-structure) reusing the existing cv2/numpy/PIL stack in
  `app/structure.py`; sets `hasDiagram` so diagram-only "questions" stop being treated
  as broken; dot-style option vs question disambiguation in `marker_extractor.py`;
  answer-key/appendix CV refinement.
- **Phase 3 (VALIDATE):** run vs AIOTS / RE NEET / AD 2601 / PHYCHE / Biology /
  Biology_Cell. Any regression → keep the flag OFF (fallback to TS).
```
