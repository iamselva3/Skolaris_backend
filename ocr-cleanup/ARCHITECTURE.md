# SKOLARIS document-intelligence architecture (FINALIZED — single engine)

**Decision (approved): one engine. Python is the single Document Engine. TS is
infrastructure only.** No 50/50 ownership, no split responsibilities, no "TS crop →
Python validate". If Python owns a question, Python owns its ENTIRE lifecycle —
including building the crop.

```
Upload → TS OCR extraction (token provider only) → Python Document Engine → TS persistence
```

One compact pipeline:
```
one PDF → one token stream → one ownership graph → one question engine
        → one crop engine → one validation engine → one delivery engine
```

## Ownership (no split)

**Python owns ALL document intelligence** (for digital / printed / scanned / mixed — no
distinction; same input contract):
- Cleanup: background / watermark / header / footer / divider / shadow / noise removal.
- Question intelligence: count, number / start / end / continuation detection, duplicate /
  Question-0 / impossible-sequence detection.
- Ownership: cross-column, cross-page, merge detection, ownership graph.
- Question reconstruction: **crop construction, crop alignment, crop repair, crop
  validation**, option / continuation / diagram attachment, whitespace reduction.
- Validation: MCQ completeness, complete-question validation, N=N=C.

**TS owns ONLY infrastructure:** OCR extraction (token provider), API, Redis, BullMQ,
Prisma, PostgreSQL, storage, authentication, business rules, answer-key logic,
persistence. TS must NEVER decide question count / crop boundaries / ownership /
continuations / merges / cross-page / cross-column / duplicates / Question 0 / impossible
sequences.

## Python BUILDS the crop (not validate)

Removed: `TS crop → Python validate`. New:
```
OCR tokens → ownership graph → logical question → assemble all owned elements
           → construct crop → align → repair → validate → deliver
```
`crop_engine.py` constructs ONE crop per logical question from the ownership graph + page
renders: per-(page,column) owned regions → crop from the render → stitch in reading order
(cross-page / cross-column) → trim whitespace → PNG. One question = one owner = one crop.

## Dormant TS (kept, not deleted)

TS structure code STAYS as a reference / debugging / **emergency fallback** — but its
authority is OFF. Activate TS only if Python crashes: Python exception, Python
unavailable, or Python timeout → TS emergency mode. Never run both. Never 50/50.

## One token contract for ALL PDFs

`{ documentId, pages: [ { index, width, height, pageImageKey, words:[{text,x0,y0,x1,y1}] } ] }`
(`words` = TS OCR tokens; `pageImageKey` = the page render Python crops from). Scanned /
digital / mixed are identical to Python — only the token source differs.

## Build status (honest)

- DONE: token intelligence (count authority, marker reconciler, ownership graph, merges,
  sequence, completeness, N=N=C) + **crop construction engine** (`crop_engine.py`, 5/5
  tested: same-page union, cross-column 2-region stitch, cross-page stitch, trim, safe).
- REMAINING before the single engine goes live (golden rule — N=N=C must pass, never
  silently deliver incorrect output, so the switch stays OFF until done + validated):
  1. Wire page renders to Python (pass `pageImageKey`; Python fetches via the read-proxy).
  2. Crop delivery contract: Python returns crop bytes per question; TS stores them (TS
     persistence; Python never touches storage/DB).
  3. CV element detectors (diagram / graph / table / equation / chem) for diagram
     attachment + crop completeness.
  4. Dormant-TS + emergency-fallback wiring (single execution; TS only on Python crash).
  5. Validate on the regression suite via the captured TS-OCR token path.

## Validation — approved path only

Same `TS OCR → Python` path for every doc; no PyMuPDF / offline shortcut. Set
`STRUCTURE_CAPTURE_DIR`, upload the regression PDFs (AIOTS 1 & DR09, AIOTS, AD, RE NEET,
Biology, Biology_Cell, PHYCHE + ≥3 unseen), then
`validate_from_tokens.py <dir>`. Regression suites only — never optimize for them.
