# Python ← TS authority transfer matrix (evidence-based, 2026-06-19)

Rule: the only question is "**Can Python replace this responsibility?**" — measured on the
REAL test documents, never faked. A PASS requires Python to produce correct output on real
tokens, not just synthetic unit tests.

**Validation method:** `validate_engine.py` extracts real per-page word boxes (PyMuPDF text
layer = the same `{text,x0,y0,x1,y1}` TS sends from OCR) and runs the engine. Honest limit:
SCANNED PDFs have no text layer → `NEEDS_OCR_TOKENS` (Python cannot run without TS OCR; not
a fail of the engine, but it cannot be validated standalone here).

## Real-document run (after the 2-up option-detection fix)

| Doc | tokens | questions | complete | review | dup | imposs | integrity |
|---|---|---|---|---|---|---|---|
| AIOTS 1 & DR09 (stress) | 0 | — | — | — | — | — | NEEDS_OCR_TOKENS (scanned) |
| AD 2601 | 0 | — | — | — | — | — | NEEDS_OCR_TOKENS (scanned) |
| RE NEET PST 3 | 211 | 0 | — | — | — | — | no extractable text → NEEDS_OCR_TOKENS |
| Biology | 4012 | 78 | 74 | 4 | 0 | 0 | STOP (4 not complete) |
| Biology_Cell | 4078 | 101 | 95 | 24 | 5 | 7 | STOP (marker noise) |
| PHYCHE | 3206 | 60 (≈50 real + ~10 false) | 60 | 28 | 4 | 16 | STOP (marker noise) |

## Transfer matrix

### Cleanup (lives in `app/cleanup.py` — separate CV engine, NOT re-validated this session)
| Responsibility | Status | Verdict |
|---|---|---|
| background removal | IMPLEMENTED | gate on cleanup-engine validation (separate) |
| watermark removal | IMPLEMENTED | gate on cleanup-engine validation |
| grey shadow / scanner noise / faded paper | IMPLEMENTED | gate on cleanup-engine validation |
| page border / divider removal | IMPLEMENTED | gate on cleanup-engine validation |
| header detection | IMPLEMENTED but UNSTABLE (over-fires) | **Keep TS** |
| footer detection | IMPLEMENTED but UNSTABLE (over-fires) | **Keep TS** |

### Structure (`structure_engine`, validated on real digital docs above)
| Responsibility | Status | Verdict |
|---|---|---|
| question start detection | PARTIAL — real markers found, but content/sub-list numbers over-detected (the `1,3,5` noise) | **Keep TS** until marker disambiguation lands |
| question end detection | WORKS on digital | earns transfer only WITH start detection |
| question continuation | WORKS (whitespace/multi-block, unit + digital) | tied to start |
| duplicate detection | WORKS (correctly fires) | PASS (detector) |
| Question 0 detection | WORKS (no false +, fires on synthetic) | PASS (detector) |
| impossible sequence detection | WORKS (correctly fires) | PASS (detector) |
| orphan option detection | IMPLEMENTED; real=0 (possible under-detect) | inconclusive → Keep TS |
| broken option detection | WORKS (≈0 false after option fix) | PASS (detector) |
| incomplete crop detection | WORKS | PASS (detector) |
| invalid crop detection | IMPLEMENTED | Keep TS (not separately validated) |

### Ownership
| Responsibility | Status | Verdict |
|---|---|---|
| cross-column ownership | IMPLEMENTED + unit-tested; NOT exercised on a real 2-col text doc | **Keep TS** (unvalidated on real) |
| cross-page ownership | IMPLEMENTED; over-merge risk on real (many multi-page) | **Keep TS** until verified |
| merge detection | IMPLEMENTED + unit-tested; real over-merge risk | **Keep TS** |
| ownership graph | WORKS (integrity gate PASS/STOP correct on digital) | PASS on digital |
| footer trail detection | NOT_IMPLEMENTED in structure engine | **Keep TS** |
| MCQ completeness | WORKS after 2-up option fix | PASS on digital |

### Visual detectors
| Responsibility | Status | Verdict |
|---|---|---|
| diagram detection | NOT_IMPLEMENTED (engine level) | **Keep TS** |
| graph detection | NOT_IMPLEMENTED | **Keep TS** |
| table detection | NOT_IMPLEMENTED (engine level; per-crop CV exists in `structure.py`) | **Keep TS** |
| equation detection | NOT_IMPLEMENTED | **Keep TS** |
| chemical structure detection | NOT_IMPLEMENTED | **Keep TS** |

## Question Count Authority (UPDATE — marker reconciler landed + validated)

`marker_reconciler.py` reconciles raw line-start numbers to the CANONICAL question markers via
margin anchoring + section-restart-safe sequence reconstruction (drops table/content/sub-list
false starts). The engine now emits `questionCount {logicalQuestionCount, completeQuestionCount,
confidence, anomalies, reconciled}`. Real-doc `count_report.py`:

| Doc | logical | dup | Q0 | imposs | missing | spurious removed | complete | ownership | N=N=C | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| PHYCHE | **50** | 0 | 0 | 0 | 0 | 10 (60→50) | 50 | PASS | PASS | **PASS** |
| Biology_Cell | 90 | 0 | 0 | 0 | 0 | 11 (101→90) | 85 | FAIL | FAIL | STOP (5 incomplete) |
| Biology | 78 | 0 | 0 | 0 | 7 | 0 | 74 | FAIL | FAIL | STOP (gaps + 4 incomplete) |
| RE NEET | 0 | — | — | — | — | — | — | — | — | NEEDS_OCR_TOKENS (sparse text) |
| AIOTS / AD | — | — | — | — | — | — | — | — | — | NEEDS_OCR_TOKENS (scanned) |

`logicalQuestionCount` counts LOGICAL questions (ownership-graph, post-reconciliation) — never
crops, never OCR token count, never persisted rows. Anomalies are surfaced, never silently
accepted. **Earned on the digital docs (PHYCHE clean PASS at the exact expected 50);** the STOPs on
Biology/Biology_Cell are correct (real incomplete questions / gaps → review, not a count error).

## Overall verdict (honest)

**Do NOT transfer document-structure ownership yet.** Per golden rule #5 (Python fails →
keep TS), Python has not earned the full transfer because:

1. **Marker disambiguation** still over-detects content/sub-list numbers on real docs
   (inflates the question set → duplicates + impossible sequences). The detectors correctly
   flag this (safety works — uncertain → review), but an engine that routes a large share to
   review is not yet a clean replacement.
2. **Scanned papers** (AIOTS stress-test, AD, RE NEET-no-text-layer) cannot be processed by
   Python without TS OCR tokens — and TS OCR extraction stays in TS by design. Validation on
   those requires the live TS→Python token feed.
3. **Visual detectors** (diagram/graph/table/equation/chem) are NOT_IMPLEMENTED.

**Earned this session (real-doc evidence):** the 2-up/multi-column **option detection** fix
took completeness from ~15% → ~95% on the digital docs (PHYCHE 10→60, Biology 3→74,
Biology_Cell 17→95), and the **completeness / broken-option / duplicate / Q0 / impossible /
ownership-graph integrity** detectors fire correctly. These are solid; they do not yet
justify removing TS authority because they sit on a question set that still contains false
starts.

## Next to earn the transfer (in order)
1. **Sequence-anchored marker filtering** (section-restart-safe): demote isolated backward-jump
   numbers that don't sustain a new ascending run → removes the `1,3,5` false starts.
2. Re-validate on all digital docs → expect duplicates/impossible → 0, integrity PASS.
3. Wire the TS→Python OCR-token feed so the SCANNED docs (AIOTS/AD/RE NEET) can be validated.
4. Build the visual detectors (diagram/graph/table/equation/chem).
5. Only then transfer responsibility-by-responsibility, each backed by real-doc evidence.
