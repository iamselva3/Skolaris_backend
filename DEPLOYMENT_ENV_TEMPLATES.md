# Production `.env` Templates — all deployment tiers

Generated from the current codebase (`src/shared/config/*`, `ocr-cleanup/app/config.py`,
`scripts/start.sh`). **Analysis only — nothing implemented.** Final architecture assumed:
512 MB instances = all digital PDFs · 1 GB workers = scanned PDFs · Node + Python sidecar
**co-located** in every unit · OCR behavior identical to local dev · debug vars absent from prod.

## Legend
- **[R] Required** — boot throws or behavior breaks if missing.
- **[O] Optional** — has a safe default; set only to change behavior.
- **[T] Tuning** — performance/memory; defaults are fine.
- **[D] Debug** — dev/diagnostics only; **must not appear in production** (unless explicitly enabled).
- **[Derived]** — injected by the platform or an IAM role; do **not** hard-code.

## Two facts that change how you read these
1. **`INSTALL_CLEANUP_CV` and RapidOCR are NOT runtime env vars** — they are **Docker build-args /
   image choices**. `docker build --build-arg INSTALL_CLEANUP_CV=1` installs the CV stack (required
   on every tier). The **1 GB image additionally installs `requirements-ocr.txt` (RapidOCR)**; the
   512 MB image does not. Nothing in `.env` toggles them.
2. **The RSS caps** (`MALLOC_ARENA_MAX=2`, `OMP/OPENBLAS/MKL/NUMEXPR_NUM_THREADS=1`) are **already
   exported by `scripts/start.sh`**. You only put them in `.env` to override (scale up). Shown as
   `[T]` and commented in the templates.

---

## Core required block (identical on every tier — shown once, referenced below)
```env
# ── App [R] ────────────────────────────────────────────────
NODE_ENV=production
# PORT — [Derived] on Render/Railway/Cloud Run (platform injects); set explicitly on VPS/ECS/EKS/Docker
CORS_ORIGINS=https://app.yourdomain.com        # [R] in prod (empty ⇒ all cross-origin blocked)

# ── Database [R] ───────────────────────────────────────────
DATABASE_URL=postgresql://user:pass@host:5432/skolaris?sslmode=require

# ── Auth [R] (boot throws if missing) ──────────────────────
JWT_ACCESS_SECRET=<32+ random chars>
JWT_REFRESH_SECRET=<32+ random chars, different>
# JWT_ACCESS_TTL=15m        # [O] default 15m
# JWT_REFRESH_TTL=7d        # [O] default 7d

# ── Storage: Cloudflare R2 / S3 [R] (bucket+region throw if missing) ──
AWS_S3_BUCKET=skolaris-uploads
AWS_REGION=auto                                  # R2: "auto"; AWS S3: e.g. ap-south-1
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # [R] for R2/MinIO; omit for real AWS S3
S3_FORCE_PATH_STYLE=true                          # [O] true for R2/MinIO
AWS_ACCESS_KEY_ID=<r2-access-key>                 # [R] except AWS-S3-on-ECS/EKS (IAM role) → [Derived]
AWS_SECRET_ACCESS_KEY=<r2-secret-key>             # [R] except AWS-S3-on-ECS/EKS → [Derived]
# S3_PUBLIC_ENDPOINT=<browser-reachable endpoint>  # [O] only if presign host ≠ S3_ENDPOINT (MinIO)
# UPLOAD_MAX_BYTES=26214400                         # [O] default 25 MiB
# UPLOAD_URL_TTL_SECONDS=900                        # [O] default 900

# ── OCR callback secret [R] (≥16 chars, boot throws) ───────
OCR_CALLBACK_SECRET=<16+ random chars>

# ── Email [O] (notifications; required only if you send mail) ─
# SMTP_HOST=  SMTP_PORT=587  SMTP_USER=  SMTP_PASS=  SMTP_FROM=  SMTP_SECURE=false
```

---

## 1) Local Development (Windows)
```env
NODE_ENV=development
PORT=3000
# CORS defaults to http://localhost:5173 in dev — no need to set

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/skolaris
JWT_ACCESS_SECRET=dev-access-secret-change-me
JWT_REFRESH_SECRET=dev-refresh-secret-change-me
OCR_CALLBACK_SECRET=dev-ocr-callback-secret

# Storage — local MinIO (S3-compatible)
AWS_S3_BUCKET=skolaris-uploads
AWS_REGION=us-east-1
S3_ENDPOINT=http://localhost:9000
S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin

# ── Node ↔ Python sidecar (co-located) [R] ──
CLEANUP_ENGINE_ENABLED=true
CLEANUP_ENGINE_URL=http://127.0.0.1:8002
CLEANUP_ENGINE=cv
OCR_TS_OWNS_CROPS=false

# Queue — inline (no Redis needed locally)
QUEUE_DRIVER=inline

# ── [D] DEBUG / DEV-ONLY (fine locally; NEVER in prod) ──
STRUCTURE_CAPTURE_DIR=c:/The Sk Learnings/Backend/Skolaris-backend/ocr-cleanup/crop-trace-out/capture
# STRUCTURE_RAPIDOCR=1        # force scanned re-OCR locally without the Node classifier
# OCR_CROP_TRACE=1            # dump per-stage crop images
```
*Notes:* `QUEUE_DRIVER=inline` ⇒ `WORKER_MODE` ignored (OCR runs in-process). RapidOCR works locally
only if installed in the venv; otherwise scanned docs degrade — same as production 512 MB.

## 2) Docker Compose (Local) — co-located single container (prod parity)
```env
NODE_ENV=production
PORT=3000
CORS_ORIGINS=http://localhost:5173

DATABASE_URL=postgresql://postgres:postgres@db:5432/skolaris      # 'db' = compose service
JWT_ACCESS_SECRET=<random>
JWT_REFRESH_SECRET=<random>
OCR_CALLBACK_SECRET=<16+ random>

AWS_S3_BUCKET=skolaris-uploads
AWS_REGION=us-east-1
S3_ENDPOINT=http://minio:9000           # 'minio' = compose service
S3_PUBLIC_ENDPOINT=http://localhost:9000
S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin

CLEANUP_ENGINE_ENABLED=true
CLEANUP_ENGINE_URL=http://127.0.0.1:8002    # same container
CLEANUP_ENGINE=cv
OCR_TS_OWNS_CROPS=false

QUEUE_DRIVER=redis
WORKER_MODE=both                            # one box does API + worker
REDIS_URL=redis://redis:6379                # 'redis' = compose service
OCR_PARALLEL_PAGES=1
```
*Two-service variant* (Node and Python as separate compose services): set
`CLEANUP_ENGINE_URL=http://cleanup:8002` (compose DNS) and run the sidecar container from
`ocr-cleanup/Dockerfile` with `INSTALL_CV=1`.

## 3) Render — 512 MB Digital Backend (standard)  ·  image built WITHOUT RapidOCR
```env
NODE_ENV=production
# PORT — [Derived] Render injects it; do NOT set
CORS_ORIGINS=https://app.yourdomain.com

DATABASE_URL=<neon/render-postgres url, sslmode=require>
JWT_ACCESS_SECRET=<secret>
JWT_REFRESH_SECRET=<secret>
OCR_CALLBACK_SECRET=<16+ secret>

AWS_S3_BUCKET=skolaris-uploads
AWS_REGION=auto
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=<r2-key>
AWS_SECRET_ACCESS_KEY=<r2-secret>

CLEANUP_ENGINE_ENABLED=true
CLEANUP_ENGINE_URL=http://127.0.0.1:8002
CLEANUP_ENGINE=cv
OCR_TS_OWNS_CROPS=false

QUEUE_DRIVER=redis
WORKER_MODE=api                 # API + enqueue; does NOT drain heavy jobs
REDIS_URL=<managed redis url>
OCR_PARALLEL_PAGES=1            # [T] keep 1 on 512 MB
# MALLOC_ARENA_MAX=2 / OMP_NUM_THREADS=1 … already set by start.sh ([T], override only to scale up)
```

## 4) Render — 1 GB Scanned OCR Worker  ·  image built WITH RapidOCR (`requirements-ocr.txt`)
```env
NODE_ENV=production
CORS_ORIGINS=https://app.yourdomain.com    # (worker doesn't serve UI, but config is shared)

DATABASE_URL=<same as 512 MB>
JWT_ACCESS_SECRET=<same>
JWT_REFRESH_SECRET=<same>
OCR_CALLBACK_SECRET=<same>

AWS_S3_BUCKET=skolaris-uploads
AWS_REGION=auto
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=<r2-key>
AWS_SECRET_ACCESS_KEY=<r2-secret>

CLEANUP_ENGINE_ENABLED=true
CLEANUP_ENGINE_URL=http://127.0.0.1:8002   # its OWN co-located sidecar
CLEANUP_ENGINE=cv
OCR_TS_OWNS_CROPS=false

QUEUE_DRIVER=redis
WORKER_MODE=worker              # drains the queue; no HTTP API
REDIS_URL=<same managed redis>
OCR_PARALLEL_PAGES=1            # [T] 1 page/inference (RapidOCR arena ~620 MB)
# OCR_QUEUE_NAME=ocr-scanned    # [O] once the scanned-queue split is wired, point the worker here
```
*Only difference from the 512 MB tier:* the **image has RapidOCR**, `WORKER_MODE=worker`, a 1 GB
instance, and (once the split is wired) it drains the scanned queue. **No RapidOCR-specific runtime
var exists** — the per-request `ocrMode='scanned'` the classifier sends drives it.

## 5) Railway
```env
NODE_ENV=production
# PORT — [Derived] Railway injects it
CORS_ORIGINS=https://app.yourdomain.com

DATABASE_URL=${{Postgres.DATABASE_URL}}        # Railway plugin reference [Derived]
JWT_ACCESS_SECRET=<secret>
JWT_REFRESH_SECRET=<secret>
OCR_CALLBACK_SECRET=<16+ secret>

AWS_S3_BUCKET=skolaris-uploads
AWS_REGION=auto
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=<r2-key>
AWS_SECRET_ACCESS_KEY=<r2-secret>

CLEANUP_ENGINE_ENABLED=true
CLEANUP_ENGINE_URL=http://127.0.0.1:8002
CLEANUP_ENGINE=cv
OCR_TS_OWNS_CROPS=false

QUEUE_DRIVER=redis
WORKER_MODE=api                                # scanned worker = 2nd Railway service, WORKER_MODE=worker
REDIS_URL=${{Redis.REDIS_URL}}                 # Railway plugin reference [Derived]
OCR_PARALLEL_PAGES=1
```

## 6) Hetzner VPS (full control — explicit everything)
```env
NODE_ENV=production
PORT=3000                                       # explicit; put Nginx/Caddy in front for TLS
CORS_ORIGINS=https://app.yourdomain.com

DATABASE_URL=postgresql://skolaris:<pass>@127.0.0.1:5432/skolaris
JWT_ACCESS_SECRET=<secret>
JWT_REFRESH_SECRET=<secret>
OCR_CALLBACK_SECRET=<16+ secret>

AWS_S3_BUCKET=skolaris-uploads
AWS_REGION=auto
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=<r2-key>
AWS_SECRET_ACCESS_KEY=<r2-secret>

CLEANUP_ENGINE_ENABLED=true
CLEANUP_ENGINE_URL=http://127.0.0.1:8002
CLEANUP_ENGINE=cv
OCR_TS_OWNS_CROPS=false

QUEUE_DRIVER=redis
WORKER_MODE=both                                # single box: API + digital worker. Scanned = a 2nd
                                                # container/process (1 GB cgroup, RapidOCR, WORKER_MODE=worker)
REDIS_URL=redis://127.0.0.1:6379
OCR_PARALLEL_PAGES=1
MALLOC_ARENA_MAX=2                              # [T] explicit (no start.sh? set these yourself)
OMP_NUM_THREADS=1
OPENBLAS_NUM_THREADS=1
```

## 7) AWS ECS / EKS
```env
NODE_ENV=production
PORT=3000                                       # container port (task/Service maps it)
CORS_ORIGINS=https://app.yourdomain.com

# Secrets via Secrets Manager / SSM → injected as env [Derived-from-secret-store]
DATABASE_URL=<rds url>
JWT_ACCESS_SECRET=<from secrets manager>
JWT_REFRESH_SECRET=<from secrets manager>
OCR_CALLBACK_SECRET=<from secrets manager>

AWS_S3_BUCKET=skolaris-uploads
AWS_REGION=ap-south-1
# AWS S3 + IAM task role → OMIT keys (SDK derives them) [Derived]
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY  → DO NOT SET (use the task role)
# S3_ENDPOINT → OMIT for real AWS S3.  If using R2 instead → set S3_ENDPOINT + keys (R2 can't use IAM)
# S3_FORCE_PATH_STYLE → omit for AWS S3

CLEANUP_ENGINE_ENABLED=true
CLEANUP_ENGINE_URL=http://127.0.0.1:8002        # both containers in the SAME task
CLEANUP_ENGINE=cv
OCR_TS_OWNS_CROPS=false

QUEUE_DRIVER=redis
WORKER_MODE=api                                 # API service; scanned = a separate 1 GB ECS service
REDIS_URL=<elasticache url>
OCR_PARALLEL_PAGES=1
```
*Key derivation:* with **AWS S3 + a task IAM role, omit `AWS_ACCESS_KEY_ID/SECRET`** (the SDK picks
up role creds). This is the **only** tier where storage creds are auto-derived — and only if you use
AWS S3 (not R2).

## 8) GCP Cloud Run / GKE
```env
NODE_ENV=production
# PORT — [Derived] Cloud Run injects PORT (often 8080); the app reads it. (GKE: set container port.)
CORS_ORIGINS=https://app.yourdomain.com

# Secrets via Secret Manager → mounted as env [Derived-from-secret-store]
DATABASE_URL=<cloud sql url>                    # via Cloud SQL connector / proxy
JWT_ACCESS_SECRET=<from secret manager>
JWT_REFRESH_SECRET=<from secret manager>
OCR_CALLBACK_SECRET=<from secret manager>

# Storage is R2/S3-only (GCS adapter removed) → Workload Identity does NOT help; set R2/S3 keys
AWS_S3_BUCKET=skolaris-uploads
AWS_REGION=auto
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=<r2-key>                       # [R] — cannot be derived on GCP
AWS_SECRET_ACCESS_KEY=<r2-secret>

CLEANUP_ENGINE_ENABLED=true
CLEANUP_ENGINE_URL=http://127.0.0.1:8002         # multi-process container / same Pod
CLEANUP_ENGINE=cv
OCR_TS_OWNS_CROPS=false

QUEUE_DRIVER=redis
WORKER_MODE=api                                  # Cloud Run service; scanned = separate 1 GB service/Job
REDIS_URL=<memorystore url>                      # needs a Serverless VPC connector on Cloud Run
OCR_PARALLEL_PAGES=1
```
*Caveat:* Cloud Run scales to zero and is request-driven — a long OCR job needs `WORKER_MODE` on a
**always-on** Cloud Run service (min-instances ≥1) or a GKE Deployment, not a scale-to-zero service.

---

## Production Environment Variable Matrix
`R`=required `O`=optional `T`=tuning `D`=debug `—`=omit/derived. "Prod value" = recommended.

| Variable | Local | Docker | Render 512 | Render 1 GB Wkr | Railway | Hetzner | AWS | GCP | Class | Purpose |
|---|---|---|---|---|---|---|---|---|---|---|
| `NODE_ENV` | development | production | production | production | production | production | production | production | R | env mode (prod ⇒ strict CORS) |
| `PORT` | 3000 | 3000 | derived | derived | derived | 3000 | 3000 | derived | R/Derived | Node public port |
| `CORS_ORIGINS` | — | localhost | app URL | app URL | app URL | app URL | app URL | app URL | R(prod) | allowed browser origins |
| `DATABASE_URL` | local PG | db svc | managed | managed | plugin | local PG | RDS | Cloud SQL | R | Postgres (boot throws) |
| `JWT_ACCESS_SECRET` | dev | rand | secret | secret | secret | secret | secret-mgr | secret-mgr | R | access-token signing (throws) |
| `JWT_REFRESH_SECRET` | dev | rand | secret | secret | secret | secret | secret-mgr | secret-mgr | R | refresh-token signing (throws) |
| `OCR_CALLBACK_SECRET` | dev | rand | secret≥16 | secret≥16 | secret≥16 | secret≥16 | secret-mgr | secret-mgr | R | OCR callback auth (throws if <16) |
| `AWS_S3_BUCKET` | bucket | bucket | bucket | bucket | bucket | bucket | bucket | bucket | R | object store bucket (throws) |
| `AWS_REGION` | us-east-1 | us-east-1 | auto | auto | auto | auto | aws-region | auto | R | region (throws) |
| `S3_ENDPOINT` | MinIO | MinIO | R2 | R2 | R2 | R2 | — (S3) | R2 | R(R2)/— | custom endpoint (R2/MinIO) |
| `S3_FORCE_PATH_STYLE` | true | true | true | true | true | true | — | true | O | path-style addressing |
| `AWS_ACCESS_KEY_ID` | minio | minio | r2 key | r2 key | r2 key | r2 key | — (IAM) | r2 key | R/Derived | storage cred (IAM-derived on AWS-S3) |
| `AWS_SECRET_ACCESS_KEY` | minio | minio | r2 sec | r2 sec | r2 sec | r2 sec | — (IAM) | r2 sec | R/Derived | storage cred |
| `CLEANUP_ENGINE_ENABLED` | true | true | true | true | true | true | true | true | R | start sidecar + allow Node→Py |
| `CLEANUP_ENGINE_URL` | loopback | loopback/svc | loopback | loopback | loopback | loopback | loopback | loopback | R | sidecar base URL (co-located) |
| `CLEANUP_ENGINE` | cv | cv | cv | cv | cv | cv | cv | cv | R | `/cleanup` engine (match local) |
| `CLEANUP_ENGINE_TIMEOUT_MS` | — | — | — | — | — | — | — | — | O | cleanup client timeout (15 s dflt) |
| `OCR_TS_OWNS_CROPS` | false | false | false | false | false | false | false | false | R | app renders Python crops |
| `QUEUE_DRIVER` | inline | redis | redis | redis | redis | redis | redis | redis | R(split) | inline vs BullMQ |
| `WORKER_MODE` | — | both | api | worker | api | both | api | api | R(split) | api/worker/both |
| `REDIS_URL` | — | redis svc | managed | managed | plugin | local | elasticache | memorystore | R(redis) | BullMQ backend |
| `OCR_PARALLEL_PAGES` | — | 1 | 1 | 1 | 1 | 1 | 1 | 1 | T | Tesseract pool (1 on small RAM) |
| `MALLOC_ARENA_MAX` | — | (start.sh) | (start.sh) | (start.sh) | (start.sh) | 2 | (start.sh) | (start.sh) | T | cap glibc arenas (RSS) |
| `OMP/OPENBLAS/MKL/NUMEXPR_NUM_THREADS` | — | (start.sh) | (start.sh) | (start.sh) | (start.sh) | 1 | (start.sh) | (start.sh) | T | single-thread BLAS (RSS) |
| `INSTALL_CLEANUP_CV` *(build-arg)* | n/a | =1 | =1 | =1 | =1 | =1 | =1 | =1 | build | install CV stack into image |
| RapidOCR *(image: `requirements-ocr.txt`)* | dev venv | optional | **NO** | **YES** | per-service | per-unit | per-service | per-service | build | scanned re-OCR engine |
| `STORAGE_READ_BASE_URL` | — | — | — | — | — | — | — | — | O | only the DI-less `scripts/ocr-worker.ts` |
| `SMTP_HOST/PORT/USER/PASS/FROM/SECURE` | — | — | opt | — | opt | opt | opt | opt | O | email (invites/reports) |
| `STRUCTURE_CAPTURE_DIR` | win path | — | **—** | **—** | **—** | **—** | **—** | **—** | D | dump token captures (no-op unset) |
| `STRUCTURE_RAPIDOCR` | opt | — | **—** | **—** | **—** | **—** | **—** | **—** | D | manual re-OCR (prod uses ocrMode) |
| `OCR_CROP_TRACE` | opt | — | **—** | **—** | **—** | **—** | **—** | **—** | D | dump per-stage crop images |
| `HANDWRITING_OCR_ENABLED` | — | — | — | — | — | — | — | — | O(off) | TrOCR route (removed) — keep off |

---

## Recommended copy-paste `.env.production` (512 MB standard, co-located)
```env
# ============================================================
#  SKOLARIS — .env.production  (512 MB digital backend)
#  Co-located Node + Python sidecar. Image: INSTALL_CLEANUP_CV=1, NO RapidOCR.
#  OCR behavior identical to local dev. Debug vars intentionally ABSENT.
# ============================================================

# ---- App (required) ----
NODE_ENV=production
# PORT injected by the platform (Render/Railway/Cloud Run). Set PORT=3000 on VPS/ECS.
CORS_ORIGINS=https://app.yourdomain.com

# ---- Database (required) ----
DATABASE_URL=postgresql://USER:PASS@HOST:5432/skolaris?sslmode=require

# ---- Auth (required) ----
JWT_ACCESS_SECRET=CHANGE_ME_32_chars_min
JWT_REFRESH_SECRET=CHANGE_ME_32_chars_min_different
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d

# ---- Storage: Cloudflare R2 (required) ----
AWS_S3_BUCKET=skolaris-uploads
AWS_REGION=auto
S3_ENDPOINT=https://ACCOUNT.r2.cloudflarestorage.com
S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=CHANGE_ME
AWS_SECRET_ACCESS_KEY=CHANGE_ME
UPLOAD_MAX_BYTES=26214400
UPLOAD_URL_TTL_SECONDS=900

# ---- OCR auth (required) ----
OCR_CALLBACK_SECRET=CHANGE_ME_16_chars_min

# ---- Node ↔ Python sidecar (required, co-located) ----
CLEANUP_ENGINE_ENABLED=true
CLEANUP_ENGINE_URL=http://127.0.0.1:8002
CLEANUP_ENGINE=cv
OCR_TS_OWNS_CROPS=false

# ---- Queue / worker split (required) ----
QUEUE_DRIVER=redis
WORKER_MODE=api                       # this instance serves API + enqueues
REDIS_URL=redis://USER:PASS@HOST:6379

# ---- Performance tuning (optional; defaults fine) ----
OCR_PARALLEL_PAGES=1
# MALLOC_ARENA_MAX=2          # already set by scripts/start.sh
# OMP_NUM_THREADS=1           # already set by scripts/start.sh
# OPENBLAS_NUM_THREADS=1      # already set by scripts/start.sh

# ---- Email (optional — only if sending mail) ----
# SMTP_HOST=  SMTP_PORT=587  SMTP_USER=  SMTP_PASS=  SMTP_FROM=no-reply@yourdomain.com  SMTP_SECURE=false

# ---- DEBUG / DEV-ONLY — DO NOT SET IN PRODUCTION ----
# STRUCTURE_CAPTURE_DIR=/tmp/ocr-capture   # only for live diagnostics; ephemeral path, never required
# STRUCTURE_RAPIDOCR / OCR_CROP_TRACE / OCR_PREPROCESS_REFLOW  → leave UNSET
```

### 1 GB scanned-worker overlay (same file, these lines differ)
```env
WORKER_MODE=worker                    # drains the queue instead of serving API
# OCR_QUEUE_NAME=ocr-scanned          # once the scanned-queue split is wired
# IMAGE built WITH RapidOCR (pip install -r ocr-cleanup/requirements-ocr.txt) on a 1 GB instance
```

## What changed vs. your local `.env` (the cleanup)
- **Removed (debug-only):** `STRUCTURE_CAPTURE_DIR` (Windows path, no-op when unset),
  `STRUCTURE_RAPIDOCR`, `OCR_CROP_TRACE`.
- **Changed value:** `NODE_ENV=production`, `QUEUE_DRIVER=inline→redis`, add `WORKER_MODE`+`REDIS_URL`,
  MinIO creds → R2 creds, add `CORS_ORIGINS`.
- **Derived, not configured:** `PORT` (platform), and `AWS_*` keys on AWS-S3+IAM (task role).
- **Unchanged (preserve identical OCR):** `CLEANUP_ENGINE_ENABLED`, `CLEANUP_ENGINE_URL`,
  `CLEANUP_ENGINE=cv`, `OCR_TS_OWNS_CROPS=false`, `OCR_PARALLEL_PAGES=1`, the RSS caps.
- **Build-time, not env:** `INSTALL_CLEANUP_CV=1` (all tiers) and RapidOCR (1 GB image only).
