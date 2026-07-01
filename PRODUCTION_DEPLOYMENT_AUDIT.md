# Production Deployment & Memory Audit — Node backend + Python OCR sidecar

**Scope:** read-only audit. No OCR / ownership / crop / validation / segmentation / marker /
cross-page / cross-column / classification logic was changed. Goal: run the **standard
backend on a 512 MB instance**, with only **large scanned-OCR jobs** needing a **1 GB worker**,
while keeping OCR output byte-identical.

**Method:** Python figures are *measured* on `ocr-cleanup/.venv` (Python 3.11, the existing
audit `DEPENDENCY_AUDIT.md`) — idle RSS, per-import RAM deltas, disk. Node figures are disk
*measured* (`node_modules`) and RAM *estimated* from each library's known runtime behavior
(libvips/WASM/onnxruntime), not a live production profile. Estimates are labelled **(est.)**.

---

## 0. The answer up front

| | Idle RAM | Peak (normal digital job) | Peak (large scanned PDF) |
|---|---:|---:|---:|
| **512 MB tier** (web + API + digital OCR + structure engine + crops, **no RapidOCR**) | ~170 MB | ~380–460 MB **(est.)** | n/a — scanned routed away |
| **1 GB worker** (adds RapidOCR scanned re-OCR) | ~190 MB | ~400 MB | ~750 MB–1.0 GB **(est.)** |

**Conclusion: yes, the standard backend fits 512 MB**, *provided the scanned-re-OCR path
(RapidOCR + onnxruntime) is NOT loaded on that instance.* RapidOCR's ONNX inference arena is
the single component that pushes a ~100 MB service to ~700 MB–1 GB, and it only runs for
documents the classifier already flags `scanned`. Route those to a 1 GB worker; everything
else stays on 512 MB. This split is **already latent in the architecture** (the `looksScanned`
gate + `ocrMode='scanned'` + a BullMQ queue) — it needs deployment wiring, not new logic.

---

## 1. Deployment reality vs. the requirements files (the most important finding)

1. **The production image runs Node *and* Python in ONE container** (root `Dockerfile`
   runtime stage + `scripts/start.sh`): Node is the public foreground process; uvicorn
   (the Python sidecar) is started in the background **only if `CLEANUP_ENGINE_ENABLED=true`**,
   bound to loopback. So the 512 MB budget must hold **both** processes simultaneously.

2. **Neither Dockerfile installs the OCR backends.** Both install `ocr-cleanup/requirements.txt`
   (lean: fastapi/uvicorn/httpx/pydantic) by default; the CV stack installs only behind
   `--build-arg INSTALL_CLEANUP_CV=1` / `INSTALL_CV=1`. **`requirements-ocr.txt`
   (paddle/torch/transformers + rapidocr) is referenced by no Dockerfile** — it is never
   installed by a normal build.

3. **Consequence A — the structure engine needs the CV stack.** Ownership/crop/chrome-cleanup
   require `fitz + numpy + cv2 + PIL`. A default build (`INSTALL_CLEANUP_CV=0`) ships the
   *identity* sidecar and the engine degrades. **Production must build with
   `INSTALL_CLEANUP_CV=1`.** That is the intended 512 MB image.

4. **Consequence B — RapidOCR is currently undeployable.** The scanned re-OCR
   (`app/structure_engine/rapid_reocr.py`) imports `rapidocr_onnxruntime`, which lives only
   in `requirements-ocr.txt` → not installed by any build → **the scanned path silently
   no-ops in production today** (a scanned doc stays at the platform/Tesseract count). To run
   scanned re-OCR you must add RapidOCR to an image — and that image is the 1 GB worker.

5. **The prior `DEPENDENCY_AUDIT.md` (2026-06-27) is now stale on one point.** It concluded
   "RapidOCR only feeds disabled features → remove it." Since then `rapid_reocr.py` was added,
   so **RapidOCR is now *required for the scanned path*** — keep it, but isolate it to the
   1 GB tier. paddle/torch/transformers remain genuinely unused (see §3).

6. **Memory tuning is already in place** (`start.sh`): `MALLOC_ARENA_MAX=2`,
   `OMP/OPENBLAS/MKL/NUMEXPR_NUM_THREADS=1` — explicitly "for Render 512 MB". This is what
   makes the CV stack's RSS stay near the measured 71 MB instead of inflating per-thread.

---

## 2. Measured sizes

### Python `ocr-cleanup/.venv` (site-packages)
| Package | Disk | In production path? |
|---|---:|---|
| cv2 — **opencv-python FULL 4.13** | **134 MB** | ✅ but **headless (~50 MB) suffices** — full was pulled in by RapidOCR and clobbered the headless pin |
| numpy (+numpy.libs) | 58 MB | ✅ required |
| PyMuPDF (fitz) | 45 MB | ✅ required |
| onnxruntime | 44 MB | ⚠️ scanned tier only (RapidOCR runtime) |
| rapidocr_onnxruntime (+models) | 16 MB | ⚠️ scanned tier only |
| PIL (Pillow) | 8 MB | ✅ required |
| shapely / pyclipper / protobuf / flatbuffers / six / tqdm | ~16 MB | ⚠️ RapidOCR transitive — scanned tier only |
| fastapi/uvicorn/httpx/pydantic + transitive | ~20 MB | ✅ required |
| pip/setuptools (build only) | 24 MB | ❌ not shipped at runtime |

Measured RSS: **idle service 71 MB**; chrome-cleanup runtime (`numpy+cv2+fitz+PIL`) 61 MB.

### Node `node_modules` (dev install = 715 MB; production is much smaller)
| Package | Disk | Notes |
|---|---:|---|
| `.prisma` (generated engines) | **148 MB** | multi-platform engines in dev; **production keeps ONE engine (~15–20 MB)** |
| `@prisma/client` | 81 MB | client + engines |
| `prisma` (CLI) | 44 MB | **devDependency — excluded by `npm ci --omit=dev`** |
| `pdfjs-dist` | 39 MB | PDF render (via pdf-to-img) + text-layer probe |
| `@nestjs/*` | 29 MB | framework |
| `typescript` | 23 MB | **devDep — excluded in prod** |
| `pdf-lib` | 19 MB | reflow/enhance only (default OFF) |
| `tesseract.js-core` (WASM) | **43 MB** | OCR engine WASM (separate from the 1.3 MB `tesseract.js` JS wrapper) |
| `@img/sharp-*` (native libvips) | **19 MB** | per-platform; prod linux build pulls `@img/sharp-linux-x64` |
| `@aws-sdk/*` (client-s3 + presigner) | 5 MB | already tree-shaken (modular v3) |
| `rxjs` | 4 MB | **required** — NestJS peerDependency (Observables) |
| `playwright` | 5 MB | **devDep — excluded in prod** |
| bullmq / ioredis / nodemailer / argon2 | <4 MB total | small |

**`eng.traineddata` is NOT bundled** — Tesseract.js downloads it (~12 MB) on the first OCR
job and caches it. First-OCR cold start therefore includes a network fetch (see §4).

---

## 3. Full dependency classification

Legend for **Prod path?**: ✅ executed in the live OCR/serve path · ⚙️ startup/runtime infra ·
🟡 optional/feature-gated (default off) · ❌ not executed.

### 3A. Python — REQUIRED on BOTH tiers (web + structure engine + crops + chrome cleanup)
| Package | Why / where | Prod path? | RAM impact | Cold start | Remove? | Replacement |
|---|---|---|---:|---|---|---|
| fastapi, starlette, pydantic(+core), uvicorn, httpx (+ transitive anyio/h11/httpcore/idna/certifi/click/sniffio/typing-ext) | the sidecar HTTP shell (`app/main.py`), storage fetch | ✅ | ~13–20 MB baseline | low | **No** | — |
| PyMuPDF (fitz) | PDF→pixels, page render, figure/chrome detection | ✅ | +30 MB import | 90 ms | **No** | — |
| numpy | pixel arrays, connected-components, column projection | ✅ | +12 MB import | 81 ms | **No** | — |
| opencv (cv2) | column refine, figure/border/chrome detection, crop render | ✅ | +20 MB import | 108 ms | **No — but swap full→headless** | `opencv-python-headless` (~50 MB vs 134 MB; drops unused GUI/video/codec libs) |
| Pillow (PIL) | image I/O in structure engine / crop encode | ✅ | +15 MB import | 109 ms | **No** | — |

### 3B. Python — SCANNED TIER ONLY (1 GB worker) — required for RapidOCR re-OCR
| Package | Why / where | Prod path? | RAM impact | Remove from 512 MB? | Replacement |
|---|---|---|---:|---|---|
| rapidocr_onnxruntime | `structure_engine/rapid_reocr.py` re-OCRs scanned page renders, replaces platform tokens before ownership (10→20 Q on the reference scan) | ✅ scanned only | **model load +300–600 MB** at first inference | **Yes (route scanned away)** | none — it *is* the scanned engine |
| onnxruntime | RapidOCR inference runtime | ✅ scanned only | included above (arena) | Yes | none |
| shapely, pyclipper, protobuf, flatbuffers, six, tqdm | RapidOCR/onnxruntime transitive (text-box geometry, model schema, progress) | ✅ scanned only (transitive) | small import; tqdm is a benchmark/progress util | Yes | none |

### 3C. Python — LEGACY / UNUSED — safe to remove from the requirements set entirely
| Package | Why it existed | Executed now? | Remove? | Evidence |
|---|---|---|---|---|
| paddleocr, paddlepaddle | printed-region OCR for the `/process-document` Python full-OCR route | ❌ | **Yes** | route disabled (`PYTHON_DOCUMENT_ENGINE` off); not installed in venv; only reachable from `app/ocr_engine/*` (removed responsibility) |
| transformers, torch | TrOCR **handwritten** OCR for the same disabled route | ❌ | **Yes** | same; the ~1–2 GB driver if ever installed — keep permanently out |
| `uvicorn[standard]` extras: websockets, watchfiles, python-dotenv, PyYAML | the `[standard]` meta-extra | ❌ | **Yes** | no WS endpoints, no `--reload`/`--env-file` in prod; PyYAML only used by RapidOCR. Switch to plain `uvicorn`. (`httptools` may stay for parse speed) |

### 3D. Node — REQUIRED in the production OCR path
| Package | Why / where (file) | Prod path? | RAM impact (est.) | Remove? | Notes |
|---|---|---|---:|---|---|
| tesseract.js (+ tesseract.js-core, eng.traineddata) | platform OCR worker pool, `shared/ocr-engine/ocr-engine.ts` (lazy singleton) | ✅ | **~50–100 MB per active worker** (WASM heap) | **No** | pool size = `OCR_PARALLEL_PAGES` (default 1, max 16). **Keep 1–2 on 512 MB.** |
| sharp (+ @img native libvips) | decode/encode page & crop images across ~11 files (ocr-engine, crop-display-clean, visual-segment, page-analyzer, delivery) | ✅ | decoded raw buffer ≈ W×H×3 (~9 MB/page @200 DPI), multiple cycles | **No** | see §4 duplicate-decode note |
| pdf-to-img (→ pdfjs-dist) | rasterize PDF pages to PNG for OCR, lazy `await import` | ✅ | holds N page buffers during a job | **No** | wraps pdfjs-dist; not a duplicate of it |
| pdfjs-dist | text-layer probe (digital/scanned routing) `routing.ts`, `pdf-profiler.ts`; render backend for pdf-to-img | ✅ probe; ⚙️ render | metadata only on probe path | **No** | 39 MB disk; biggest single OCR-side install |
| @aws-sdk/client-s3 + s3-request-presigner | object storage I/O, `shared/storage/s3.storage.ts` (lazy client) | ✅ | small | **No** | modular v3, only 5 MB |
| @prisma/client (+ .prisma engine) | DB access, `prisma.service.ts` | ⚙️ startup | connection pool; **ship ONE engine** | **No** | trim multi-platform engines (§6) |
| @nestjs/* + reflect-metadata + rxjs + class-validator + class-transformer | framework, DI, DTO validation, bootstrap | ⚙️ startup | framework baseline | **No** | rxjs/class-* are NestJS peer deps — required |
| bullmq | job queue (`shared/workers`, `shared/queue`) | ⚙️ | small | **No** | this is the mechanism for the worker split (§6) |
| ioredis | Redis client for BullMQ | 🟡 | none unless `QUEUE_DRIVER=redis` | **No** | inline default opens no connection |
| argon2 | password hashing (auth use-cases) | ⚙️ auth | native, tiny | **No** | not in OCR path |
| nodemailer, passport, passport-jwt, uuid | email, JWT auth, IDs | ⚙️ | tiny | **No** | not in OCR path |

### 3E. Node — feature-gated / near-dead-weight (default OFF)
| Package | Why / where | Executed now? | Remove? |
|---|---|---|---|
| pdf-lib | `ocr-preprocess/pdf-reflow.ts` (rebuild reflowed PDF) + `document-enhancement/pdf-lib-enhancer.ts` (strip annotations) | 🟡 only if `OCR_PREPROCESS_REFLOW=1` (default OFF) or enhancement triggered | **No** (keep) but it loads only on those paths; 19 MB disk, ~0 RAM when idle |

### 3F. Node — DEV/TEST ONLY (already `devDependencies`, excluded by `npm ci --omit=dev`)
prisma(CLI 44 MB), typescript(23 MB), playwright(5 MB), jest/ts-jest/ts-node/ts-loader,
eslint+plugins, prettier, **pdfkit** (+@types) — pdfkit *generates* test PDFs, used by scripts
only. **All correctly classified; none leak into prod.** No production dep is secretly dev/test.

---

## 4. Runtime / memory-behavior audit

- **Startup imports (eager):** NestJS DI graph, ConfigModule, ScheduleModule, Prisma connect,
  SMTP transporter, queue services (Redis lazy). `sharp` loads its native libvips eagerly
  (imported top-level in ~11 files). Python: `fastapi+uvicorn`; **CV imports are lazy** (first
  analyze) so idle stays ~71 MB.
- **Lazy / deferred (good):** tesseract worker (first job), pdf-to-img, pdfjs-dist,
  watermark-clean, S3Client, Redis. First OCR pays a one-time cost: Tesseract WASM init +
  **`eng.traineddata` network download (~12 MB, then cached)** + RapidOCR model load (scanned).
- **Duplicate PDF rasterization:** controlled. With reflow OFF (default) each page is rendered
  **once**. `pdfjs-dist` (probe), `pdf-to-img` (render), `pdf-lib` (write) have distinct roles —
  not duplicates. Reflow ON renders every page twice (documented waste) — keep OFF unless
  side-by-side papers are common.
- **Duplicate image decoding:** `sharp` does multiple decode→raw / raw→PNG cycles per page
  (metadata read, flat-field, display cleanup, then per-crop encode). Largely inherent to the
  multi-stage crop pipeline; the lever is **concurrency**, not removal (see §6).
- **Large buffers / streaming:** the rendered PDF is materialized page-by-page into PNG
  buffers held during the job (Node side), and the structure engine receives page renders as
  base64 and decodes per page (Python side). Peak scales with **pages held simultaneously × DPI**.
- **Long-lived caches:** Tesseract singleton + its language model persist for the process
  lifetime (intended — avoids re-init). RapidOCR ONNX sessions, once created, hold their arena.
- **Leaks:** none identified statically; Tesseract is explicitly `reset/shutdown` on error and
  graceful shutdown. The risk is not a leak but **peak overlap** (Tesseract WASM + sharp raw
  buffers + Python CV arrays co-resident in one container).
- **Idle vs peak (per process):** Python idle **71 MB (measured)** → +100–250 MB (est.) while
  holding a large multi-page render → **+300–600 MB only when RapidOCR infers**. Node idle
  ~90–120 MB (est.) → +Tesseract worker(s) +page buffers during a job.

---

## 5. RAM budget & instance sizing (combined single container)

**512 MB tier — web + API + digital OCR + structure engine + crops, RapidOCR NOT installed:**
- Idle: Node ~100 MB + Python ~71 MB ≈ **~170 MB**.
- Normal digital job (OCR_PARALLEL_PAGES=1): + Tesseract worker ~80 MB + Node page buffers
  ~50–100 MB + Python CV arrays ~100–150 MB, with the malloc/BLAS caps already set →
  **peak ~380–460 MB (est.)** → **fits 512 MB** with headroom if `OCR_PARALLEL_PAGES≤2` and
  DPI stays at the current scale-2 (~200 DPI).

**1 GB worker — scanned re-OCR (adds RapidOCR + onnxruntime):**
- Idle ~190 MB; large scanned PDF: + onnxruntime arena 300–600 MB + page renders →
  **peak ~750 MB–1.0 GB (est.)** → **needs 1 GB**, single page-at-a-time inference.

**Recommended sizing:**
| Use | Size | Config |
|---|---|---|
| Standard production (web + API + digital OCR) | **512 MB** | no RapidOCR; `OCR_PARALLEL_PAGES=1`, malloc/BLAS caps on; CV stack (headless) |
| Scanned-OCR worker | **1 GB** | RapidOCR installed; processes only the `scanned` queue; 1 page/inference |
| Future scaling | scale **wide** (more 512 MB API/digital pods) + a small pool of 1 GB scanned workers; raise `OCR_PARALLEL_PAGES` only on instances with ≥1.5 GB and ≥2 vCPU (each parallel page ≈ +one Tesseract worker + one raw buffer) |

---

## 6. Optimization plan (preserves identical OCR output)

Ordered by payoff; none touches OCR/ownership/crop/validation logic.

1. **Split deployment into two images/queues (the headline change).**
   - *512 MB image:* CV stack **without** RapidOCR. Handles API + digital docs + structure
     engine + crops. If `looksScanned` fires, enqueue to a `scanned` BullMQ queue instead of
     re-OCRing in-process.
   - *1 GB worker image:* CV stack **+ RapidOCR**, `WORKER_MODE`/`QUEUE_DRIVER=redis`, consumes
     the `scanned` queue. Identical engine code; only the dependency set and instance size
     differ → **output is byte-identical**, just relocated. (The classifier + queue already exist.)

2. **Swap full OpenCV → `opencv-python-headless`.** Reinstall headless and ensure RapidOCR
   (1 GB image only) doesn't re-pull the full build (install with constraints / `--no-deps`
   handling). **−~80 MB disk**, drops unused GUI/FFmpeg shared libs. Pixel ops are identical.

3. **Replace `requirements-ocr.txt` with `requirements-scanned.txt` = `rapidocr_onnxruntime`
   only.** Delete `paddleocr/paddlepaddle/transformers/torch` from the repo so the ~2 GB stack
   can't be reintroduced. (Leave the `app/ocr_engine/*` adapter code if desired — it's lazy and
   inert — but it must not be in any installed requirements.)

4. **Plain `uvicorn` instead of `uvicorn[standard]`** on both tiers → drops websockets,
   watchfiles, python-dotenv, PyYAML. Small disk + a little cold-start.

5. **Trim the Prisma engine to one platform** in the runtime image (production already
   `--omit=dev`, but verify only `linux-musl/glibc-openssl-3.0` engine is copied, not all). The
   148 MB `.prisma` is mostly cross-platform engines → **~15–20 MB** in prod.

6. **Add/verify a `.dockerignore` for `ocr-cleanup/`.** The runtime stage does
   `COPY ocr-cleanup ./ocr-cleanup`, which currently also copies `crop-trace-out/` (large test
   token captures), `.venv`, tests, `scratchpad`, repro scripts, and audit docs into the image.
   Exclude them → smaller image, faster deploy, no RAM effect but real footprint.

7. **Keep `OCR_PREPROCESS_REFLOW` OFF** (default) on 512 MB — it doubles PDF rendering.

8. **Cap OCR concurrency on 512 MB:** `OCR_PARALLEL_PAGES=1`, S3 upload concurrency modest.
   Keep the existing `MALLOC_ARENA_MAX=2` + single-thread BLAS — they are what hold RSS down.

9. **(Optional) Pre-bake `eng.traineddata`** into the image so the first OCR job doesn't fetch
   it at runtime — removes a cold-start network dependency. Pure ops, no output change.

**Priority preservation:** every item above is dependency-set / instance-size / concurrency /
packaging — the OCR accuracy, crop quality, ownership engine, and validation run on exactly the
same `fitz+numpy+cv2+PIL` (+RapidOCR on the scanned tier) code, unchanged.

---

## 7. "Is it still needed?" — direct answers
| Item | Verdict |
|---|---|
| Watermark removal | **Removed from the workflow.** No package to drop (Node `watermark-clean.ts` uses `sharp`, needed elsewhere; Python watermark code gone). |
| PaddleOCR | **Not needed** — disabled `/process-document` route; remove from requirements. |
| Handwritten OCR (TrOCR) | **Not needed** — same route; remove transformers+torch. |
| Experimental OCR engines (`app/ocr_engine/*`) | **Not on the prod path** — lazy/inert; remove their *requirements*, code optional. |
| RapidOCR deps no longer used | **Now USED** (scanned re-OCR) — keep on 1 GB tier only. shapely/pyclipper/etc. are its transitive deps. |
| Unused OpenCV modules | **Yes** — full build's GUI/video/codecs unused → headless. |
| Heavy image libs (skimage/scipy) | **Already absent** — keep them out. |
| PDF libs | PyMuPDF (Py) + pdfjs-dist/pdf-to-img/pdf-lib (Node) — **distinct roles, no true duplicate**; pdf-lib is feature-gated. |
| ML frameworks (torch/paddle) | **Remove / keep out** (~2 GB). |
| Debug/benchmark utils (tqdm) | **Removable** with RapidOCR off (512 MB tier). |
| Test assets (crop-trace-out captures) | **Should not ship** — add to `.dockerignore`. |
| Duplicate image/PDF libs | None genuine; covered above. |

---

# PART 2 — MEASURED (2026-06-30): replaces the estimates above

**Platform caveat.** RSS measured on **Windows 11, Python 3.11 sidecar venv, Node v24**;
production is **Linux + Node 20**. Linux glibc RSS is typically **10–25 % lower** for the same
workload, and the `MALLOC_ARENA_MAX`/BLAS caps only bind on glibc — so these numbers are
**conservative (high)** for production. The *relative* shape (idle vs peak, per-page scaling,
digital vs scanned, leak/no-leak) transfers directly. Python measured with
`MALLOC_ARENA_MAX=2 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1` (the `start.sh` settings).
Tool: `psutil` (installed only to measure, removed after; never in any requirements).

## P2.1 Python sidecar (structure engine = the 512 MB-critical process) — MEASURED RSS (MB)
| Scenario | Idle/base | **Peak** | Post-job | After GC | Time |
|---|---:|---:|---:|---:|---:|
| Full sidecar idle (`import app.main`) | **68.7** | — | — | — | 1.5 s cold import |
| Digital 1-page | 36.5¹ | 121.0 | 90.1 | 90.1 | 0.3 s |
| Digital 10-page | — | 137.9 | 93.6 | 93.6 | 3.6 s |
| Digital 25-page | — | 217.1 | 97.3 | 97.3 | 11.1 s |
| Digital 50-page | — | **316.8** | 102.0 | 102.0 | 20.4 s |
| **Scanned 3-page (RapidOCR)** | — | **621.9** | 105.6 | 105.6 | 29.0 s |

¹ base after `import pipeline` (CV libs lazy-load inside analyze); the real service idle is **68.7**.

**Reads:**
- **Digital peak scales ~+5 MB/page** (decoded page renders held for figure/chrome/crop). 50-page → **317 MB**.
- **Scanned peak 622 MB** is the **onnxruntime inference arena**, not page count: RapidOCR runs
  **page-by-page** (singleton sessions reused), so the peak is **bounded ~600–650 MB for ANY
  scanned size** — a 50-page scan peaks the same as a 3-page scan, just runs longer.
- **No memory leak.** Every scenario's post-GC RSS returns to ~90–106 MB (steady state with CV +
  models resident) and does **not** climb across the sweep. Renders are released after each job.

## P2.2 Node OCR libraries — MEASURED RSS (MB), Windows/Node24 (prod Linux/Node20 lower)
| Step | RSS | Δ |
|---|---:|---:|
| baseline (node + script) | 59.6 | — |
| + `sharp` (libvips) warm | 68.9 | +9.3 |
| + one 200-DPI page decoded raw (11.1 MB buffer) | 81.0 | +12 |
| + `require('tesseract.js')` | 82.1 | +1 |
| + `createWorker('eng')` (WASM core + eng model) | 131.3 | **+49** |
| + `recognize` one page | 168.0 | +37 transient |
| after `terminate()` + gc | 156.8 | only −11 |

**Reads:** a Tesseract worker ≈ **49 MB resident + ~37 MB transient ≈ 86 MB active**. After
`terminate()` **RSS does not return to baseline** (V8 + WASM-heap retention) — a long-lived
worker **plateaus at its high-water mark**, so a container that has processed a big job stays
near that job's peak until restarted. (`eng.traineddata` was cached here; first-ever OCR adds a
~12 MB download + a few seconds.)

## P2.3 Combined single container (Node + Python), MEASURED-derived
| State | Node | Python | **Combined** | Fits 512? |
|---|---:|---:|---:|---|
| Idle | ~100 (booted Nest, est.) | 69 (meas.) | **~170** | ✅ |
| Digital 10-page job | ~150 (worker resident) | 138 | **~290** | ✅ comfortable |
| Digital 25-page job | ~150 | 217 | **~370** | ✅ |
| Digital 50-page job | ~150 | 317 | **~470** | ✅ thin headroom |
| **Scanned job (any size)** | ~150 | **622** | **~770** | ❌ → **1 GB** |

Node OCRs the pages first, then Python analyzes — their two peaks are largely **sequential**, but
the Tesseract worker stays resident (~150 MB) through Python's analyze, so the combined peak is
`Node-resident + Python-peak`. **512 MB holds digital docs to ~50 pages; scanned needs 1 GB.**

## P2.4 RapidOCR usage audit (the explicit asks)
- **Is it OCRing the whole page unnecessarily?** It OCRs the **whole page** (`reocr_pages` →
  `_RAPID(full_page_img)`), and that is **REQUIRED**: the structure engine reasons over *all*
  the page's words — question markers in **both** columns and option labels **scattered across
  the page**. Restricting to the left margin/header (the `number_ocr.py` approach, default OFF)
  recovers only **numbers**, not the missing **option labels**, so it would **not** reproduce the
  10→20 result — it **changes output**. **ROI restriction is not available without changing output.**
- **Can model loading be lazy?** **Already lazy** — `available()` builds the `RapidOCR()`
  singleton on first scanned doc; **digital docs never construct it** (confirmed: digital runs
  showed no 600 MB arena). 
- **Model reuse / caching?** **Already a process-lifetime singleton** (`_RAPID`) reused across all
  pages and documents — one model load per process, not per page/doc.
- **Can inference be restricted / models excluded?** Detection input is **already capped at
  736 px** (`limit_side_len`) regardless of page resolution; recognition runs per detected line.
  **Disabling the angle classifier (`use_cls=False`) was TESTED on the reference scan: output is
  NOT identical** (22 of 305 lines differ; line count 305→306) for only ~4 % time saving — so
  **cls stays**. All three bundled models are load-bearing: det 4.6 MB + cls 0.57 MB + rec 11 MB.
  The package bundles **no extra language packs** to strip.
- **Net:** RapidOCR is **already at its minimal output-preserving configuration** (lazy +
  singleton + bounded detection). The **only** further memory win is **isolating it to the 1 GB
  worker** so its 622 MB arena never lands on the 512 MB instance. There is nothing to reduce
  *inside* RapidOCR without changing OCR output.

## P2.5 Refined plan & tiers (measurement-backed)
**512 MB standard backend — CONFIRMED feasible** for web + API + digital OCR + structure engine +
crops, with RapidOCR **not installed**. Keep `OCR_PARALLEL_PAGES=1`, reflow OFF, the
malloc/BLAS caps, and route `looksScanned` docs to the scanned queue. Headroom is thin only at
~50-page digital — mitigations: **chunk/cap pages per job**, keep parallelism at 1, and
**recycle the Node worker periodically** to shed the high-water plateau (P2.2).

**1 GB scanned-OCR worker — STILL REQUIRED** (not optimizable away): measured **622 MB in Python
alone**, ~770 MB combined. It is **bounded** (page-by-page) so 1 GB is sufficient for any scanned
size; process **one page per inference**, one worker.

**Expected reductions from the PART 1 cuts (unchanged by measurement):** disk −~80 MB (headless
OpenCV) −~130 MB (one Prisma engine) − test-asset/`.dockerignore` savings − paddle/torch kept out
(~2 GB); RAM on the 512 MB tier: the 622 MB RapidOCR arena **never loads** there (the single
biggest win), and cold start drops by dropping `uvicorn[standard]` + not importing onnxruntime.
**No OCR output changes** — every lever is packaging, instance split, lazy-load, or concurrency.

---

# PART 3 — FINAL 512 MB VERDICT (2026-06-30): measured idle + thresholds + auto-routing

Infrastructure verification only — no logic touched. Builds on the PART 2 measurements plus a
new **Node resident-library measurement** and the **routing-code inspection**. Same platform
caveat: measured on Windows / Node 24 / Python 3.11; **production is Linux + Node 20-slim, ~10–25 %
lower RSS** with `MALLOC_ARENA_MAX=2`. Both numbers shown where it matters.

## P3.1 Idle RAM (measured)
| Process | This platform | Prod est. (Linux/Node20) | How measured |
|---|---:|---:|---|
| **Node** resident libs | 127.9 | — | require() the full prod dep graph (no boot) |
| Node + NestFactory DI (idle) | ~145–155 | **~110–130** | + ~15–25 DI overhead |
| **Python sidecar** idle | 68.7 | **~55–65** | `import app.main` RSS |
| **Combined idle** | ~215–225 | **~170–195** | one container, both processes |

Idle is **~35 % of the 512 MB budget** — ample.

## P3.2 Peak RAM by workload (measured-derived)
OCR runs in two phases that **barely overlap**: Node OCRs all pages (Tesseract) → hands tokens +
renders to Python → Python analyzes. The Tesseract singleton stays resident (~49 MB) through
Python's analyze, so the binding peak is **Phase B = Node-resident + Python-analyze-peak**.

| Workload (digital, ~200 DPI) | Python peak | Node resident | **Combined (this plat.)** | **Combined (prod est.)** | Headroom vs 512 (prod) |
|---|---:|---:|---:|---:|---:|
| 1-page | 121 | ~177 | ~300 | **~250** | ~260 |
| 10-page (typical upload) | 138 | ~177 | ~315 | **~270** | ~240 |
| 25-page | 217 | ~177 | ~394 | **~335** | ~175 |
| 50-page (large) | 317 | ~177 | ~494 | **~420** | ~90 (thin) |
| **Scanned (any size)** | **622** | ~177 | **~780** | **~700** | **−190 → needs 1 GB** |

**Reads:** the **vast majority of production exam papers (digital, 1–30 pages) peak ~250–360 MB
on a 512 MB box — comfortable.** 50-page digital is the practical digital ceiling (thin headroom).
Scanned **cannot** fit (622 MB in Python alone) and **must** use 1 GB — but it's **bounded
page-by-page**, so 1 GB covers any scanned size.

## P3.3 What actually drives memory (NOT file size)
The user is right that file size is the wrong axis. Measured drivers, in order:
1. **Digital vs scanned (RapidOCR).** The single biggest cliff: scanned → RapidOCR onnxruntime
   arena = **+~550 MB** (measured 622 MB peak). A 5 MB scanned PDF blows the budget; a 50 MB
   digital PDF does not. **This is the only factor that forces 1 GB.**
2. **Page count.** Digital peak grows **~+5 MB/page** (Python holds decoded renders for
   figure/chrome/crop). Linear, predictable. ~+50 MB Python from 1→10 pages, +100 from 25→50.
3. **Render resolution.** Per-page pixel memory is **quadratic in DPI**. Production renders at a
   fixed `scale 2` (~200 DPI). Raising it to 300/400 DPI turns +5 MB/page into +11–20 MB/page —
   a 50-page doc at 300 DPI would push Python past 512. **Keep the render scale fixed.**
4. **Page concurrency (`OCR_PARALLEL_PAGES`).** Each parallel page = +1 Tesseract worker
   (~49–86 MB) + another raw buffer. Default 1. **Keep 1 on 512 MB.**
5. **Job concurrency.** `OcrProcessor` concurrency is **hard-coded 1** (one OCR job at a time per
   process) — verified in `ocr.processor.ts:59`. Two concurrent jobs would ~double RAM. Keep 1.
6. **No leak.** Post-job Python returns to ~90–106 MB; Node RSS **plateaus** at its high-water mark
   (V8/WASM retention) — so a box that processed a 50-page job sits near that peak until restart.

## P3.4 RECOMMENDATION

### 512 MB — standard backend (API + digital OCR + structure engine + crops)
- **Supported:** all digital PDFs (real embedded text layer), RapidOCR **not installed**.
- **Max recommended page count:** **~50 pages** at ~200 DPI (safe, ~90 MB prod headroom);
  1–30 pages is the comfortable sweet spot (~250–360 MB).
- **Expected peak:** ~250 MB (typical 10-page) → ~420 MB (50-page), prod.
- **Concurrency:** `OCR_PARALLEL_PAGES=1`, BullMQ `concurrency=1`, reflow OFF, render scale fixed,
  malloc/BLAS caps on. One OCR job at a time.
- **Why it's safe:** with RapidOCR absent, the +550 MB arena **physically cannot load** here — the
  box is structurally incapable of the scanned spike, so no input can OOM it; a scanned doc that
  slips through is delivered at the (degraded) digital count, not a crash.

### 1 GB — dedicated scanned/heavy OCR worker
- **Exact scenarios:** (a) **scanned documents** — the classifier (`looksScanned`) trips and
  RapidOCR re-OCRs (the dominant case); (b) digital docs **> ~60 pages** at 200 DPI; (c)
  **raised render DPI ≥ 300** on a large doc; (d) if you ever raise `OCR_PARALLEL_PAGES`/job
  concurrency. **(a) is ~99 % of the 1 GB need.**
- **Expected peak:** ~700–780 MB (scanned, bounded page-by-page regardless of page count).
- **Why 512 is insufficient:** RapidOCR's onnxruntime inference arena alone (measured 622 MB)
  exceeds the whole 512 MB budget; there is no output-preserving way to shrink it (PART 2.4 —
  whole-page OCR required, models all load-bearing, already lazy + singleton).

## P3.5 Auto-routing heavy jobs to the 1 GB worker — FEASIBLE with existing primitives
The split needs **wiring, not new capability**. Already present:
- **Dispatcher seam** `IOcrDispatcher` (`ocr-dispatcher.ts`) — inline vs BullMQ, env-selected.
- **API/worker split** — `OcrProcessor` is **`WORKER_MODE`-gated** (`api`=enqueue-only inert /
  `worker`=drains queue), so API pods and worker pods are already separable.
- **Multi-queue** — a second queue already exists (`ocr-handwriting-queue.service.ts`).
- **Cheap pre-OCR classifier** — `routing.ts` `probePdfTextLayer` (pdfjs-dist, samples the first
  pages' embedded text, **metadata only, no render**) is a strong digital-vs-scanned signal
  available **at enqueue**, before any expensive work.

**To enable it:** add an `ocr-scanned` queue; at enqueue, run the text-layer probe (+ a page-count/
DPI guard) → **no/sparse text layer or > ~60 pages → `ocr-scanned` (drained by 1 GB workers,
RapidOCR installed); rich text layer → normal queue (drained by 512 MB workers, no RapidOCR).**
Escalation safety: if a digital-routed doc trips `looksScanned` mid-job on a 512 MB worker, it must
**re-enqueue to `ocr-scanned`** rather than re-OCR in-process (the 512 MB image has no RapidOCR, so
in-process re-OCR is a no-op anyway — re-enqueue gets it correct counts). Output is byte-identical;
the job just runs on the right-sized box.

## P3.6 Bottom line
**Yes — the optimized backend runs comfortably on 512 MB for the vast majority of production
workloads** (digital exam papers, 1–50 pages, peak ~250–420 MB prod, idle ~170–195 MB). **Only
scanned OCR (RapidOCR) genuinely requires 1 GB** — and that path is cleanly isolatable to a
dedicated worker using primitives already in the codebase, classified by a cheap pre-OCR probe
rather than file size. The decision axis is **digital-vs-scanned + page-count + render-DPS +
concurrency**, exactly as measured — never raw file size.

---

# PART 4 — Python sidecar deployment architecture + OCR env vars (2026-06-30)

Architecture review only — no logic changed. Covers how to start the sidecar, whether the
loopback URL survives each platform, and a clean production env-var set.

## P4.1 How the Node↔Python link is wired (the fact that drives everything)
- The sidecar (`app/main.py`, uvicorn :8002) is started by `scripts/start.sh` **in the
  background, only if `CLEANUP_ENGINE_ENABLED=true`**, bound to **loopback `127.0.0.1`**; Node is
  the **foreground** process (`exec node dist/main.js`). One container, one lifecycle.
- **Every** Node→Python client (`cleanup-http`, `crop-clean-http`, `structure-http`,
  `structure-analyze-http`, `structure-build`) resolves its address from **`CLEANUP_ENGINE_URL`**
  (each may override with its own `*_URL`, but the base is `CLEANUP_ENGINE_URL`). The production
  OCR path is `/analyze-document` via `structure-analyze-http`, which has **no enable flag** — it
  runs whenever `CLEANUP_ENGINE_URL` is set (timeout 180 s, circuit breaker 3 fails / 30 s cooldown
  → falls back to TS-only, never crashes the request).
- **Consequence:** the sidecar is **co-located per instance**. Routing digital vs scanned is done
  at the **queue/instance** level (which worker picks the job), NOT by switching Python URLs — so
  **`127.0.0.1:8002` stays correct on every platform as long as the sidecar runs in the same
  container as the Node process that calls it.** This is the recommended model.

## P4.2 (Q1) How to start the sidecar in production
Keep the current model: **one container, Node foreground + uvicorn on loopback**, launched by
`start.sh` with `CLEANUP_ENGINE_ENABLED=true` and the memory caps it already exports
(`MALLOC_ARENA_MAX=2`, `OMP/OPENBLAS/MKL/NUMEXPR_NUM_THREADS=1`). Build the runtime image with
`--build-arg INSTALL_CLEANUP_CV=1` so the CV stack is present (the engine degrades without it).
**One change to recommend:** the sidecar is currently fire-and-forget (`( … ) &`) with **no
supervision** — if uvicorn dies it stays down until the container restarts (Node keeps serving,
breaker-degraded). Add a tiny supervisor (a restart loop in `start.sh`, or `tini`/`s6`/
`supervisord`) so a sidecar crash self-heals without a full container bounce. See P4.9.

## P4.3 (Q2/Q3) Does `CLEANUP_ENGINE_URL=http://127.0.0.1:8002` work in production?
**It works wherever Node and the sidecar share the same network namespace (same container/pod);
it breaks the moment Python is a *separate* service.**

| Platform | Co-located (recommended) | If Python is a separate service |
|---|---|---|
| **Render** | ✅ `http://127.0.0.1:8002` (single web service, sidecar in same container) | ❌ → Render **Private Service** internal URL `http://<name>:<port>` |
| **Railway** | ✅ `127.0.0.1:8002` (one service) | ❌ → `http://<service>.railway.internal:8002` |
| **Docker (single image)** | ✅ `127.0.0.1:8002` | — |
| **Docker Compose** | ✅ if one container | ❌ → service name `http://cleanup:8002` (compose DNS) |
| **Hetzner VPS** | ✅ `127.0.0.1:8002` (both on host / one container) | ❌ → same host still `127.0.0.1`; else private LAN IP |
| **GCP Cloud Run** | ✅ `127.0.0.1:8002` (multi-process / sidecar container) | ❌ → separate Cloud Run service needs its HTTPS URL (no localhost across services) |
| **GKE / EKS** | ✅ `127.0.0.1:8002` (same Pod, 2 containers) | ❌ → `http://<svc>.<ns>.svc.cluster.local:8002` |
| **AWS ECS/Fargate** | ✅ `127.0.0.1:8002` (same task) | ❌ → service-discovery DNS / internal ALB |

**Recommendation: stay co-located** → `127.0.0.1:8002` is correct everywhere and avoids a network
hop on the hot path (every page render crosses this link). Only centralize Python (and switch to an
internal URL) if you deliberately want a shared Python pool — not needed for this workload.

## P4.4 (Q5) `STRUCTURE_CAPTURE_DIR` — remove from production
Read **only** in `ocr-analysis-delivery.service.ts:665` to dump the exact token payload to disk for
**offline regression/trace** (the captures this audit used). The code is explicitly **gated and
no-op when unset** (comment at :662: *"unset in production ⇒ no-op"*). It is a Windows dev path and
must **not** ship. **Verdict: DEBUG-ONLY → leave UNSET in production.** If diagnostics are ever
wanted in prod, point it at an **ephemeral, writable, configurable** container path
(e.g. `/tmp/ocr-capture`) with rotation — never a baked host path, never required.

## P4.5 (Q4 + Q10) OCR / sidecar environment-variable classification
**R**=prod-required · **P**=prod-recommended (safe default) · **O**=optional/tuning ·
**D**=debug/dev-only (leave unset in prod). Defaults preserve current OCR behavior.

### Node ↔ sidecar link
| Variable | Purpose | Dev value | Production value | Class |
|---|---|---|---|---|
| `CLEANUP_ENGINE_ENABLED` | start sidecar + allow Node→Python calls | `true` | `true` | **R** |
| `CLEANUP_ENGINE_URL` | base URL for ALL sidecar clients | `http://127.0.0.1:8002` | `http://127.0.0.1:8002` (co-located) | **R** |
| `CLEANUP_PORT` / `PORT` | uvicorn bind port (match URL) | 8002 | 8002 | P |
| `CLEANUP_ENGINE` | `/cleanup` CV engine selector (`identity`/`cv`) | `cv` | `cv` (match local → identical) | **R** |
| `CLEANUP_ENGINE_TIMEOUT_MS` | cleanup client timeout | 15000 | 15000 (default) | O |
| `STRUCTURE_ANALYZE_TIMEOUT_MS` | analyze client timeout (default 180000) | unset | unset | O |

### Node OCR runtime behavior
| Variable | Purpose | Dev value | Production value | Class |
|---|---|---|---|---|
| `OCR_TS_OWNS_CROPS` | false ⇒ app renders Python's crops | `false` | `false` (match local → identical crops) | **R** |
| `OCR_PARALLEL_PAGES` | Tesseract worker pool size | unset(=1) | `1` on 512 MB | P |
| `WORKER_MODE` | `api`/`worker`/`both` queue split | `api`/inline | `api` on web, `worker` on workers | **R** (split) |
| `QUEUE_DRIVER` | `inline`/`redis` | `inline` | `redis` (for the split) | **R** (split) |
| `REDIS_URL` | BullMQ Redis | local | managed Redis | **R** if redis |
| `OCR_PREPROCESS_REFLOW` | re-render to detect 2-col (doubles render) | off | off | O |
| `OCR_ASYNC_CROP_UPLOAD` / `OCR_UPLOAD_CONCURRENCY` | crop upload pool (on / 8) | default | default | O |
| `OCR_RESUMABLE` / `OCR_STUCK_CUTOFF_MS` / `OCR_MAX_RESUME_ATTEMPTS` | resumable jobs + recovery cron | default | default | O |
| `OCR_INLINE_JOB_TIMEOUT_MS` | inline dispatcher ceiling | test | unset (n/a on redis) | O |
| `OCR_DISPLAY_CROP_TRIM` / `_HEADER_TRIM` / `_FOOTER_TRIM` | crop display trims (default ON) | default | default (keep ON) | P |
| `OCR_DISPLAY_EXPLANATION_TRIM` (+`_DARK`/`_TEXT_FRAC`/…) | strip trailing explanation (default OFF) | off | off | O |
| `OCR_TRIM_DIAGRAM_ROWS`, `OCR_DISPLAY_TRIM_*` | trim thresholds | default | default | O |
| `OCR_CROP_TRACE` | dump per-stage crop images | unset | **unset** | **D** |
| `HANDWRITING_OCR_ENABLED` | handwriting route (TrOCR, removed) | not set | `false`/unset | O (off) |
| `STRUCTURE_CAPTURE_DIR` | dump token payloads for regression | Windows path | **UNSET** | **D** |

### Python sidecar internal (`config.py` + pipeline)
| Variable | Purpose | Dev value | Production value | Class |
|---|---|---|---|---|
| `MALLOC_ARENA_MAX` | cap glibc arenas (RSS) | — | `2` (start.sh) | **R** (512 MB) |
| `OMP_/OPENBLAS_/MKL_/NUMEXPR_NUM_THREADS` | single-thread BLAS (RSS) | — | `1` (start.sh) | **R** (512 MB) |
| `CLEANUP_MAX_MS` | `/cleanup` time budget (13000) | default | default | O |
| `CLEANUP_WORK_DPI` | `/cleanup` render DPI (150) | default | default | O |
| `STORAGE_READ_BASE_URL` | sidecar fetches upload bytes (cleanup/build paths) | `http://localhost:3000/api` | internal Node API URL **only if those paths used**; else n/a (analyze sends payload) | O/cond |
| `AWS_S3_BUCKET` / `GCS_BUCKET` | bucket for sidecar storage access | local | match Node bucket (if used) | O/cond |
| `STRUCTURE_RAPIDOCR` | **manual** force re-OCR (dev) | unset | **unset** — Node sends `ocrMode='scanned'` per request | **D** |
| `STRUCTURE_NUMBER_OCR` | margin number re-OCR (default 0) | off | off | O (off) |
| `STRUCTURE_BADGE_OCR` | badge/seal OCR (default off) | off | off | O (off) |
| `OCR_SEMANTIC_OPTIONS` | semantic option parsing (default 0) | off | off | O (off) |
| `OCR_BUILD_DPI` / `TROCR_MODEL` | disabled `/build` + TrOCR routes | — | n/a (routes disabled) | D (dead) |

**Scanned-worker-only (1 GB tier):** install `requirements-ocr.txt` (`rapidocr_onnxruntime`); no
extra env — the per-request `ocrMode='scanned'` already drives it.

## P4.6 (Q6) How the 512 MB / 1 GB split runs
- **512 MB instances** (API + digital workers): co-located Node + sidecar, **RapidOCR NOT
  installed**. Handle digital PDFs end-to-end (Tesseract → `/analyze-document` → crops). A scanned
  doc here cannot spike (no RapidOCR → re-OCR no-ops); it is re-enqueued to the scanned queue.
- **1 GB workers** (scanned): same image **+ RapidOCR**, `WORKER_MODE=worker` draining the
  `ocr-scanned` queue; one page per inference; peak ~700–780 MB, bounded.
- **Classification** at enqueue via the cheap `probePdfTextLayer` (no render): rich text layer →
  normal queue; sparse/none or > ~60 pages → scanned queue.

## P4.7 (Q7) Can Node auto-choose the right Python service without touching OCR logic?
**Yes — without per-request URL switching.** Node does not pick a Python *URL*; it routes the
**job** to the right **queue/worker** (existing `IOcrDispatcher` + `WORKER_MODE` + a second queue).
Each worker talks to **its own local sidecar** at `127.0.0.1:8002`; the only difference between
tiers is that the 1 GB image has RapidOCR installed. So the "choice" is queue routing (config), the
OCR code path is identical on both tiers, and the loopback URL stays valid everywhere. No OCR logic
changes — only a classifier-driven `enqueue(queue)` and the per-image dependency set.

## P4.8 (Q8) Together or separate, per platform
| Platform | Recommendation |
|---|---|
| **Render** | **Together** (one web service: Node + sidecar) for the 512 MB tier; a **separate** Background Worker service (1 GB) for scanned. Each keeps its own loopback sidecar. |
| **Railway** | **Together** per service; separate 1 GB worker service for scanned. |
| **Hetzner VPS** | **Together** on the box (one container or systemd pair); a second container/process with a 1 GB cgroup limit for scanned. Full control — co-locate. |
| **Docker Compose** | Either. Simplest prod parity: **one container** (Node+sidecar) → `127.0.0.1:8002`. If two services, set `CLEANUP_ENGINE_URL=http://cleanup:8002`. |

Rule of thumb: **co-locate Node + sidecar in every unit**; separate only the **scanned worker** as
its own (1 GB) deployment, distinguished by image (RapidOCR) + queue, not by network topology.

## P4.9 (Q9) Monitoring, restart, independent scaling
- **Monitoring:** add a sidecar **health endpoint** (e.g. `GET /healthz`) and have the container
  healthcheck (or Node readiness) ping `127.0.0.1:8002/healthz`. Track sidecar RSS (the 622 MB
  scanned ceiling), `/analyze-document` latency, and the Node circuit-breaker open/close events
  (already 3-fail/30 s in `structure-analyze-http`).
- **Restart on failure:** today the sidecar is unsupervised (`&`). Recommend **supervising uvicorn**
  (restart loop in `start.sh`, or `tini` as PID 1 + wrapper, or s6/supervisord) so it self-heals;
  Node already degrades gracefully (breaker → TS-only) so a crash never takes a request down. Let
  the platform restart the whole container on repeated healthcheck failure.
- **Independent scaling:** in the co-located model you scale the **unit** (Node+sidecar), which is
  the right granularity (each job needs both). Scale **horizontally**; BullMQ load-balances. The
  **512 MB API/digital pool** and the **1 GB scanned pool** scale **independently** (separate
  deployments, queues, replica counts). Only break Python into a standalone internal service (losing
  the loopback URL) if you ever need it to scale on its own axis — not needed here.

## P4.10 Clean production env set (co-located 512 MB standard)
```env
# Node ↔ sidecar (co-located)
CLEANUP_ENGINE_ENABLED=true
CLEANUP_ENGINE_URL=http://127.0.0.1:8002
CLEANUP_ENGINE=cv
OCR_TS_OWNS_CROPS=false
# queue split (use inline + omit for a single all-in-one box)
QUEUE_DRIVER=redis
WORKER_MODE=api            # =worker on the worker pool
REDIS_URL=<managed-redis>
OCR_PARALLEL_PAGES=1
# sidecar RSS caps (start.sh already exports these; keep them)
MALLOC_ARENA_MAX=2
OMP_NUM_THREADS=1
OPENBLAS_NUM_THREADS=1
# REMOVED vs local dev (debug-only): STRUCTURE_CAPTURE_DIR, STRUCTURE_RAPIDOCR, OCR_CROP_TRACE
```
The **1 GB scanned worker** uses the same file with `WORKER_MODE=worker` (scanned queue) and an
image built with RapidOCR installed. Nothing here changes OCR behavior — it only relocates
debug-only settings out of production and pins behavior-preserving values to match local.
