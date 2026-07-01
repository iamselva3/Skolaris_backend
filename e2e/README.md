# Live OCR Regression Suite

Uploads each regression paper through the **real running pipeline** (login → upload → OCR → drafts)
and enforces **hard acceptance counts** — not improvement metrics. `179/180` is a **FAIL**.

| Paper | Expected (hard) |
|---|---|
| Biology_Cell | **90** |
| Biology | **85** |
| PHYCHE | **50** |
| 25 REP @ sk | **180** |
| AD 2601 Q | **180** |
| AIOTS 1 & DR09 @ sk_0476 | **180** |

A paper passes only when: `deliveredCount === expected` **and** every delivered crop is valid **and**
every failure category (duplicates, Question-0, impossible/unordered, missing numbers, missing/detached
options, crop-boundary) is **zero** **and** the result is **deterministic** (same PDF uploaded N times →
identical delivered set).

## One-time setup

```bash
npm i -D @playwright/test         # the suite is API-driven; no browsers download needed
```

## Prerequisites to RUN

1. **The 6 real PDF files** in one folder — they are NOT in the repo. The suite resolves each by
   filename pattern (e.g. a file containing `phyche`, `ad2601`, `aiots`/`dr09`/`0476`, `25rep`,
   `biology_cell`, `biology`). A paper whose PDF is absent is **skipped** with a message (never a silent pass).
2. **The full stack running**: API on `:3000`, the Python sidecar on `:8002` **freshly restarted**
   (a stale sidecar runs old code — see the "stale" flag at `GET :8002/healthz`), DB, storage, Redis.
3. **Credentials** for a SUPER_ADMIN or TEACHER user.

## Run

```bash
# PowerShell
$env:E2E_BASE_URL='http://localhost:3000'
$env:E2E_EMAIL='you@example.com'; $env:E2E_PASSWORD='...'   # $env:E2E_TENANT='slug'  if multi-tenant
$env:REGRESSION_PDF_DIR='D:\path\to\regression-pdfs'
$env:E2E_ITERATIONS='2'                                      # determinism iterations (min 2)
npm run regression:e2e
```

Output:
- Per-paper report printed to the console with every field
  (Expected / Logical / Ownership / Complete / Crop / Delivered counts, Missing / Recovered / Duplicates,
  Question 0, Impossible, Cross-page/column, Diagram/Graph/Table/Equation/Chemical, Header/Footer,
  Crop-boundary, Missing/Detached options, Deterministic, Stage 1/2 N=N=C, PASS/FAIL).
- `e2e/report/regression-report.json` — machine-readable full report.
- `e2e/report/trace-<paper>.txt` — for any FAIL, a stage trace that names every missing question and its
  delivered neighbours (where to look), rather than stopping at "178/180".

## Notes

- **Ownership / Stage-1/2 N=N=C / per-visual issue counts** come from the Python authority report
  (`GET /api/ocr/jobs/:id/authority`). In the current hybrid analyze mode that endpoint can return
  `null` (the rich Python report is logged, not yet persisted). When it's `null` the suite still
  enforces the HARD acceptance from the delivered drafts (count + crop validity + sequence integrity);
  the Python-internal fields show `N/A`. Wiring the upload validation report into the authority endpoint
  (so those fields populate) is a one-change follow-up.
- The suite never mutates data beyond uploading; it does not approve/discard drafts.
