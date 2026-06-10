# SKOLARIS Handwriting OCR microservice (optional fallback)

A **separate, optional** Python service that augments — never replaces — the
Node `tesseract.js` OCR pipeline. The Node side routes a job here only when it
detects handwritten / low-confidence content (see `HANDWRITING_OCR_ENABLED` and
`src/shared/ocr-engine/routing.ts`). This service returns drafts via the **same
HMAC-signed callback contract** (`OcrCallbackDto`), so the review UI never knows
which engine produced the text.

## How it fits

```
Node consumer routes  ─▶ BullMQ 'ocr.handwriting'  ─▶ this service
   (Node writes nothing for routed jobs)                │
                                                         ▼
   download bytes (same GCS URL)  →  engine.recognize()  →  parse_drafts()
   →  POST /api/internal/ocr/callback  (x-ocr-signature = HMAC-SHA256(secret, raw body))
   →  HandleOcrCallbackUseCase  →  drafts + upload → READY_FOR_REVIEW
```

The terminal callback is posted by **exactly one** component per job (Node for
printed/high-confidence, this service for routed jobs) — so there is no double
write.

## Engines (`HW_OCR_MODEL`)

| value | deps | use |
|-------|------|-----|
| `stub` (default) | none | contract testing — returns canned drafts, no models |
| `paddle` (recommended) | `requirements-paddle.txt` + poppler | detection+recognition, CPU-friendly |
| `trocr` | `requirements-trocr.txt` + poppler | TrOCR handwritten; single-region baseline (segment lines for dense sheets) |

## Run

Via compose (from the backend repo), behind a profile so normal `up` is unchanged:

```bash
# 1. enable routing on the API
export HANDWRITING_OCR_ENABLED=true
# 2. start the service (stub by default — instant, no models)
docker compose --profile handwriting up ocr-handwriting
```

Build a real engine image:

```bash
docker compose build --build-arg INSTALL_ML=paddle ocr-handwriting
# then set HW_OCR_MODEL=paddle on the service
```

Local (without Docker):

```bash
pip install -r requirements.txt           # stub mode
# pip install -r requirements-ml.txt -r requirements-paddle.txt   # for paddle
export REDIS_URL=redis://localhost:6380 OCR_CALLBACK_SECRET=<same-as-API> \
       OCR_CALLBACK_URL=http://localhost:3000/api/internal/ocr/callback \
       GCS_API_ENDPOINT=http://localhost:4443 HW_OCR_MODEL=stub
uvicorn app.main:app --host 0.0.0.0 --port 8001
```

## Env

| var | default | notes |
|-----|---------|-------|
| `REDIS_URL` | `redis://localhost:6379` | same broker as the API |
| `HW_OCR_QUEUE_NAME` | `ocr.handwriting` | must match the Node producer |
| `OCR_CALLBACK_URL` | `…:3000/api/internal/ocr/callback` | the API callback |
| `OCR_CALLBACK_SECRET` | — (required, ≥16 chars) | **must match the API** |
| `GCS_BUCKET` / `GCS_API_ENDPOINT` | `skolaris-uploads` / `…:4443` | same download convention |
| `HW_OCR_MODEL` | `stub` | `stub` \| `paddle` \| `trocr` |
| `HW_OCR_DEVICE` | `cpu` | `cpu` \| `cuda` |
| `HW_OCR_PDF_DPI` | `200` | PDF raster DPI (real engines) |

## Endpoints

- `GET /healthz` — liveness + config echo.
- `GET /readyz` — `200` once the model is warmed (gate traffic on this).
- `POST /ocr/extract` `{ "storageKey": "...", "mime": "application/pdf" }` — sync
  extract that returns drafts **without** posting the callback (engine testing only).
- `POST /ocr/extract-structured` `{ "storageKey": "...", "mime": "application/pdf" }` —
  Slice 2.2 path: returns per-page text + per-word bounding boxes so the Node
  side can run column reorder + parseDrafts itself. Returns 501 from engines
  that don't implement `recognize_structured` (e.g. `stub`); the Node dispatcher
  then degrades to its local tesseract path.

## Slice 2.2: switching the printed-paper pipeline to PaddleOCR

For real coaching-centre papers (NEET / JEE — circled-digit options, dense
2-column layouts, formula chars) Node's tesseract.js stops at ~34% MCQ
detection. The Python service exposes PaddleOCR PP-OCRv4 via
`/ocr/extract-structured`; turning it on is opt-in and degrades safely.

Recipe:

```bash
# 1. Start the Python service with PaddleOCR
cd ocr-handwriting
pip install -r requirements.txt -r requirements-paddle.txt
HW_OCR_MODEL=paddle \
  OCR_CALLBACK_SECRET=<same as backend> \
  STORAGE_READ_BASE_URL=http://localhost:3000/api \
  uvicorn app.main:app --host 0.0.0.0 --port 8001

# 2. Flip the Node-side flag (in .env or shell)
PRINTED_OCR_VIA_PADDLE=true
PRINTED_OCR_URL=http://localhost:8001
PRINTED_OCR_TIMEOUT_MS=180000

# 3. Restart dev:full and re-upload the benchmark paper.
#    The engine log will show "[ocr-engine] printed OCR via Paddle service (Np)".
#    If the service is down or slow, you'll see a one-line warn and the
#    upload completes via the tesseract path — never blocked.
```

The circuit breaker is independent of the handwriting fallback's breaker (so a
slow handwriting engine doesn't poison the printed path, and vice versa).

## Slice 2.4: garbage-cluster filter (diagram-leak fix)

PaddleOCR's text detector reads pixels INSIDE diagrams (circuit symbols, chemistry
structures, formula blocks) and emits low-confidence garbage tokens — "@", "€o",
"3C @ 5 c 1" etc. Before Slice 2.4, those tokens flowed through `recognize_structured`
into the question stem on the Node side. Slice 2.4 catches them in PaddleEngine:

- After PaddleOCR returns lines, `_separate_garbage_clusters()` finds groups of
  **≥2 spatially-adjacent tokens** where each is either (a) low confidence
  (`conf < OCR_GARBAGE_CONF_THRESHOLD`) or (b) a short symbol-heavy token like
  `@`, `©`, `€`.
- Each cluster's bounding box is **cropped from the page as a PNG figure** and
  emitted alongside the text-hole figures — so the diagram is preserved as an
  image and attached to the nearest draft.
- The cluster's tokens are **removed from the word list** before text-hole
  figure detection runs, so the secondary detector finally sees clean rows.
- Singletons (a single mangled `ε₀` that PaddleOCR confused) are kept — only
  clusters of 2+ are dropped, so legitimate low-confidence math/Greek characters
  are not nuked.

Tuning lives in `.env` (loaded by the Python service):
- `OCR_GARBAGE_CONF_THRESHOLD` (default 0.65)
- `OCR_GARBAGE_PROXIMITY_PX` (default 60)
- `OCR_GARBAGE_MIN_CLUSTER` (default 2)

## Contract notes (do not break)

- HMAC is verified over the **exact raw request body bytes**. We serialize the
  payload once and sign+send those identical bytes (`app/callback.py`). Never
  re-encode between signing and sending.
- The callback is **idempotent** on the API side; a retried job that already
  delivered returns `alreadyProcessed: true` — treat it as a benign no-op.
- `providerUsed` is recorded on `OcrJob` (e.g. `paddle-hw`, `trocr`); the schema
  field already exists, so no migration is needed.
