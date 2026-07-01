# SKOLARIS Document Cleanup (internal sidecar)

A small **internal** Python service that removes background artifacts from a
document **before** OCR — watermarks, headers, footers, borders, dividers,
scanner noise, stains, grey backgrounds, repeated logos — **without ever touching
content** (question numbers, text, options, diagrams, graphs, tables, equations,
chemical structures, match connectors, labels).

It is **not** a public app and **not** a second OCR. Node owns everything
(queues, storage, OCR flow); this service only preprocesses bytes Node hands it.

## Architecture

Same pattern as `ocr-handwriting/`. Ownership is decided **once** by the Node
Document Profiler — never a fallback:

| Document | Owner | Engine |
|---|---|---|
| Digital PDF | `pdf-lib` | Node pre-dispatch enhancement (not this service) |
| Scanned PDF | `python` | this service |
| Image upload | `python+sharp` | Sharp normalize + this service |

Node calls this service **inside the async OCR job** (never on the upload request
path), via `src/shared/ocr-engine/cleanup-http.ts`.

### Contract

```
POST /cleanup   { storageKey, mime, ocrJobId, owner }
  → header X-Cleanup-Changed: true|false
      true  → body = cleaned file bytes        (Node persists them; Node owns storage)
      false → empty body                        (Node keeps the original)
GET  /healthz   → liveness
GET  /readyz    → readiness
```

## Deployment: ONE container (Python runs inside the Node image)

There is **no separate service / VM / cloud app**. In production the cleanup engine
runs as a **private background process inside the API container** (see the repo
`Dockerfile` runtime stage + `scripts/start.sh`): `start.sh` launches `uvicorn` on
`127.0.0.1:8002` in the background, then `exec node`. Node is the public app and the
foreground process (one deploy, one log stream, one restart unit); Python is bound
to loopback and never exposed. If uvicorn dies, Node keeps serving and the cleanup
client circuit-breaks to the original bytes.

The runtime image is Debian slim (glibc) so the OpenCV / PyMuPDF / scikit-image
wheels install. The CV stack is baked in only with `--build-arg INSTALL_CLEANUP_CV=1`.

## Status: real CV engine written, DEFAULT OFF until validated

`app/cleanup.py` implements the real protect-mask algorithm (Otsu ink → connected
components → dilated protect mask → isolated-line / speck / repeated-band removal →
paper-colour fill of non-protected pixels → strict validation, else return ORIGINAL).
It is a **no-op unless `CLEANUP_ENGINE=cv`**, and even then every failure / validation
miss returns the original bytes. It must be **validated in Docker against real papers
before being enabled** — never ship unvalidated pixel manipulation.

## Run

- **Docker (production-shaped):** `docker compose up` — the cleanup engine starts
  inside the api container when `CLEANUP_ENGINE_ENABLED=true`. Build the CV image:
  `INSTALL_CLEANUP_CV=1 docker compose build api`, then run with
  `CLEANUP_ENGINE_ENABLED=true CLEANUP_ENGINE=cv docker compose up`.
- **Local dev (`npm run dev`):** starts the engine from `ocr-cleanup/.venv` when
  present and `CLEANUP_ENGINE_ENABLED=true`. Create the venv once:
  `cd ocr-cleanup && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt -r requirements-cv.txt`
  (Linux/macOS: `.venv/bin/pip`). On a host without Python, use Docker instead.
