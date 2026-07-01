# Python Service — Dependency & Runtime Audit

**Scope of audit:** read-only. No functionality changed. Goal: classify every installed
package as **required / optional / removable** for the *current* mandate — content-safe
removal of repeated **headers, footers, borders and page chrome** before OCR.

All sizes and RAM/import figures below are **measured on this machine** against
`ocr-cleanup/.venv` (Python 3.11, win_amd64), not estimated from metadata.

---

## 1. Key findings (the short version)

1. **The installed venv does not match the requirements files.** `requirements-cv.txt`
   pins `opencv-python-headless`, but the **live `cv2` is the full `opencv-python` 4.13
   (134 MB)** — it overwrote the headless 4.10 build. The headless `.dist-info` is still
   present but its files were clobbered.

2. **One package caused the entire bloat: `rapidocr-onnxruntime`.** Its declared
   dependencies are:
   `opencv-python` (full, **not** headless), `onnxruntime`, `shapely`, `pyclipper`,
   `six`, `tqdm`, `PyYAML`, `Pillow`, `numpy`. `onnxruntime` then adds `flatbuffers` +
   `protobuf`. So installing RapidOCR is *exactly* what (a) defeated the headless OpenCV
   pin and (b) added an entire 9-package OCR runtime cluster.

3. **RapidOCR only feeds disabled / removed features**: the OCR-engine fallback
   (`ocr_engine`, a removed responsibility) and the margin/badge **number OCR**, which is
   **OFF by default** (`STRUCTURE_NUMBER_OCR=0`, `STRUCTURE_BADGE_OCR` unset — see
   `structure_engine/pipeline.py:161` and `:90`). The chrome-cleanup path
   (`cleanup.py`) imports **only** `fitz` + `numpy` + `cv2`. RapidOCR is never on that path.

4. **The heavy OCR backends in `requirements-ocr.txt` (`torch`, `paddlepaddle`,
   `paddleocr`, `transformers`) are NOT installed** in this venv. They are listed but
   absent. Those are the real ~1–2 GB drivers *if ever installed* — they should be deleted
   from the requirements set so nobody re-installs them.

5. **Measured idle footprint of the running service is 71 MB RSS** — not 1 GB. The 1 GB
   figure is reached only when (a) `onnxruntime`/RapidOCR load their ONNX models at OCR
   runtime, (b) a large multi-page PDF render is held in RAM, and most of all (c) if
   `torch`/`paddle` were installed. Removing the OCR cluster eliminates (a) and (c)
   entirely. See §5 for the full RAM decomposition.

---

## 2. Measured cost of each library

Working-set RAM is the **marginal** cost of importing that module into a fresh
interpreter (baseline interpreter = 13 MB). Disk is the unpacked size under
`site-packages`.

| Library | Disk | Import RAM (Δ) | Import time | On chrome-cleanup path? |
|---|---:|---:|---:|---|
| **cv2 (full opencv-python 4.13)** | **134 MB** | +20.5 MB | 108 ms | ✅ (but headless suffices) |
| onnxruntime | 44 MB | +31.7 MB | 174 ms | ❌ OCR only |
| numpy | 38 MB | +11.9 MB | 81 ms | ✅ |
| rapidocr-onnxruntime | 16 MB | +46.3 MB¹ | 292 ms | ❌ OCR only |
| Pillow (PIL) | 8 MB | +14.6 MB | 109 ms | ✅ |
| shapely (+libs) | 8 MB | +15.8 MB | 96 ms | ❌ OCR only |
| pydantic_core | 6 MB | — | — | ✅ |
| PyMuPDF / PyMuPDFb (fitz) | ~12 MB | +30.2 MB | 90 ms | ✅ |
| pyclipper | 1 MB | +1.3 MB | 11 ms | ❌ OCR only |
| flatbuffers / protobuf / six / tqdm | ~5 MB | small | — | ❌ OCR only |

¹ RapidOCR's +46 MB includes its transitive `onnxruntime`+`shapely`+`numpy` load; at
**run time** (when an ONNX session is actually created) it loads detection+recognition
models and an inference arena, which is hundreds of MB more — the real runtime cost.

**Measured combined sets:**
- Chrome-cleanup runtime (`numpy+cv2+fitz+PIL`): **61 MB** RSS.
- Full web service import (`fastapi+uvicorn+httpx+pydantic` + CV): **96 MB** RSS.
- Actual `import app.main` (real service, lazy CV): **71 MB** RSS, 776 ms.
- Total `site-packages` on disk today: **362 MB**.

---

## 3. Full package classification (all 38 installed)

### A. Web / server core — **REQUIRED** (the service is a FastAPI sidecar)

| Package | Why it exists | Used? | Safe to remove |
|---|---|---|---|
| fastapi 0.115.0 | HTTP framework (`app/main.py`) | Yes | **No** |
| starlette 0.38.6 | FastAPI core | Yes (transitive) | No |
| pydantic 2.9.2 | request models | Yes | No |
| pydantic_core 2.23.4 | pydantic engine | Yes (transitive) | No |
| annotated-types 0.7.0 | pydantic | Yes (transitive) | No |
| uvicorn 0.30.6 | ASGI server (Docker `CMD`) | Yes | No |
| httpx 0.27.2 | storage fetch (`storage.py`) | Yes | No |
| httpcore 1.0.9 | httpx transport | Yes (transitive) | No |
| h11 0.16.0 | HTTP/1.1 for uvicorn+httpcore | Yes (transitive) | No |
| anyio 4.14.1 | async core for starlette/httpx | Yes (transitive) | No |
| sniffio 1.3.1 | anyio | Yes (transitive) | No |
| idna 3.18 | httpx/anyio | Yes (transitive) | No |
| certifi 2026.6.17 | httpx TLS roots | Yes (transitive) | No |
| click 8.4.2 | uvicorn CLI | Yes (transitive) | No |
| typing_extensions 4.15.0 | pydantic/fastapi typing | Yes (transitive) | No |
| colorama 0.4.6 | click color on Windows | Yes (transitive) | No |

### B. `uvicorn[standard]` extras — **OPTIONAL** (trim for prod)

| Package | Why it exists | Used? | Safe to remove |
|---|---|---|---|
| httptools 0.8.0 | faster HTTP parser | Perf only | Optional |
| websockets 16.0 | WS protocol | **No WS endpoints** | **Yes** |
| watchfiles 1.2.0 | `--reload` (dev) | Dev only | **Yes** (prod) |
| python-dotenv 1.2.2 | `--env-file` | Not used | **Yes** |
| PyYAML 6.0.3 | uvicorn log-config **+** RapidOCR | Not used by us | **Yes** |

> Switching `uvicorn[standard]` → plain `uvicorn` drops all five. They are small but
> pure dead weight for a localhost JSON sidecar.

### C. CV stack — **REQUIRED for chrome cleanup**

| Package | Why it exists | Used? | Safe to remove |
|---|---|---|---|
| PyMuPDF 1.24.10 (+PyMuPDFb) | PDF render → pixels (`cleanup.py`) | Yes | No |
| numpy 2.1.1 | pixel arrays / CC stats | Yes | No |
| **opencv-python-headless 4.10** | intended `cv2` | **Yes (intended)** | No |
| Pillow 10.4.0 | PIL image I/O in structure engine | Yes | No |

### D. **REMOVABLE** — exists only for disabled/removed OCR features

| Package | Why it exists | Used today? | Safe to remove | Replacement |
|---|---|---|---|---|
| **opencv-python 4.13 (full)** | pulled by RapidOCR; overwrote headless | Redundant | **Yes** | re-pin `opencv-python-headless` |
| rapidocr-onnxruntime 1.4.4 | OCR fallback + badge/number OCR (default OFF) | No | **Yes** | none (feature removed) |
| onnxruntime 1.27.0 | RapidOCR runtime | No | **Yes** | none |
| shapely 2.1.2 | RapidOCR dep | No | **Yes** | none |
| pyclipper 1.4.0 | RapidOCR dep | No | **Yes** | none |
| flatbuffers 25.12.19 | onnxruntime dep | No | **Yes** | none |
| protobuf 7.35.1 | onnxruntime dep | No | **Yes** | none |
| six 1.17.0 | RapidOCR dep | No | **Yes** | none |
| tqdm 4.68.3 | RapidOCR progress bars | No | **Yes** | none |

### E. Build tooling (leave as-is)
`pip 24.0`, `setuptools 65.5.0`, `packaging 26.2` — installer plumbing, not shipped at runtime.

### F. Listed in requirements but **NOT installed** — delete from requirements
`torch 2.4.1`, `paddlepaddle 2.6.1`, `paddleocr 2.8.1`, `transformers 4.44.2`
(`requirements-ocr.txt`). These are the real 1–2 GB drivers. They are not in this venv;
keep them out and remove the file so they cannot be reintroduced.

---

## 4. Optimized dependency list for the current architecture

Current mandate only: **header / footer / border removal + safe page cleanup + content
preservation.** That path uses `fitz + numpy + cv2(headless) + PIL` and a FastAPI shell.

**`requirements.txt` (proposed — single file):**
```
# Web sidecar
fastapi==0.115.0
uvicorn==0.30.6            # plain, NOT [standard] — no WS/reload/dotenv needed
pydantic==2.9.2
httpx==0.27.2

# CV preprocessing stack (chrome cleanup + render)
PyMuPDF==1.24.10
opencv-python-headless==4.10.0.84
numpy==2.1.1
Pillow==10.4.0
```

**Delete:** `requirements-ocr.txt` (torch/paddle/transformers) and `requirements-cv.txt`
(folded above). Drop the `INSTALL_CV` build-arg split in the Dockerfile — there is only one
tier now.

**Uninstall from the live venv:**
```
opencv-python rapidocr-onnxruntime onnxruntime shapely pyclipper \
flatbuffers protobuf six tqdm websockets watchfiles python-dotenv PyYAML
```
then `pip install opencv-python-headless==4.10.0.84 --force-reinstall` to restore the
headless `cv2` that the full build clobbered.

> ⚠️ This decommissions the already-degraded OCR routes (`/process-document`,
> `/ocr-document`) and the default-off number/badge OCR. They are not part of the stated
> mandate and already fail closed (paddle/torch absent), but confirm Node no longer calls
> them before uninstalling.

---

## 5. Where the RAM actually goes — and what the cut removes

**Honest accounting:** with *this* venv (no torch/paddle), the service does **not** sit at
1 GB. Measured idle RSS = **71 MB**. The path to ~1 GB has three contributors, two of which
the cut eliminates:

| Contributor | When it hits | RAM | Removed by this audit? |
|---|---|---|---|
| Web + CV import (steady state) | always | ~71 MB | No — required |
| Multi-page render arrays held in RAM | during `/cleanup` of a big PDF | 100–250 MB (≈9 MB/page × N, all pages buffered in `cleanup.py`) | No — but bounded by `work_dpi` |
| **onnxruntime + RapidOCR model arena** | when number/badge/fallback OCR runs | **+300–600 MB** | **✅ Yes — gone** |
| **torch + paddlepaddle** (if `requirements-ocr.txt` ever installed) | model load | **+1–2 GB** | **✅ Yes — kept out** |

So the reduction is real and attributable to specific packages:
- **Disk:** removing the OCR cluster frees **67 MB**, and swapping full→headless OpenCV
  frees a further **~80 MB** (134 MB → ~50 MB). Total **~150 MB** off a 362 MB install
  (**~40 %**), plus the elimination of `requirements-ocr.txt` keeps torch/paddle's
  ~2 GB permanently out.
- **RAM:** removing `onnxruntime`+`rapidocr` removes the **only non-CV component that loads
  model weights and an inference arena at runtime** — the 300–600 MB spike that turns a
  ~100 MB service into a near-1 GB one whenever OCR fires. The headless OpenCV swap also
  drops the GUI/codec shared libraries (GTK/FFmpeg) that the full build maps in.
- **Cold start:** dropping `onnxruntime` (174 ms) + `rapidocr` (292 ms) + the
  `uvicorn[standard]` extras trims import time, and the warmup thread no longer probes a
  heavier OpenCV.

**Preprocessing accuracy is unchanged:** the entire header/footer/border/logo/speck
detection in `cleanup.py` and the repeated-chrome detectors run on `fitz + numpy +
cv2(headless) + PIL` only. None of the removed packages is reachable from that path —
proven by the import scan (every `rapidocr`/`onnxruntime` reference lives in `ocr_engine/*`
or the default-off `number_ocr`/`badge_detector`).
