"""FastAPI entrypoint for the SKOLARIS Document Cleanup microservice.

INTERNAL localhost sidecar (same architecture as ocr-handwriting). Node owns
everything (queues, storage, OCR flow); this service ONLY preprocesses a document
by removing background artifacts WITHOUT ever touching content. No OCR. No AI.

It is OPTIONAL: the Node pipeline runs fine without it (CLEANUP_ENGINE_ENABLED off
on the Node side). Bring it up with `docker compose up` (it is an always-on
internal service) or, for local non-docker dev, `npm run dev` starts it from a
venv when present.

Contract (called by Node src/shared/ocr-engine/cleanup-http.ts):
  POST /cleanup  { storageKey, mime, ocrJobId, owner }
    -> response header `X-Cleanup-Changed: true|false`
         true  -> body = cleaned file bytes (application/pdf or image/*)
         false -> empty body (Node keeps the original; Node owns storage)
  GET /healthz   -> liveness
  GET /readyz    -> readiness
"""
import asyncio
import logging
import os
import time
from typing import Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from .cleanup import clean_document
from .config import settings
from .storage import fetch_object
from .structure import analyze_structure
from .structure_engine import analyze_document

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("ocr-cleanup")

app = FastAPI(title="SKOLARIS Document Cleanup")

# ── CODE-FRESHNESS PROBE ────────────────────────────────────────────────────────────────────────
# uvicorn has NO auto-reload, so a Python edit only takes effect after a HARD sidecar restart. A stale
# process (or an orphan still holding :8002) silently serves OLD code — which shows up as wrong crops.
# We fingerprint the engine source at boot (latest .py mtime) and re-check it on every /healthz, so one
# look at GET :8002/healthz says definitively whether the RUNNING code matches what's on disk.
_APP_DIR = os.path.dirname(os.path.abspath(__file__))


def _latest_source_mtime() -> float:
    latest = 0.0
    for root, _dirs, files in os.walk(_APP_DIR):
        for f in files:
            if f.endswith(".py"):
                try:
                    latest = max(latest, os.path.getmtime(os.path.join(root, f)))
                except OSError:
                    pass
    return latest


_BOOT_SRC_MTIME = _latest_source_mtime()
_BOOTED_AT = time.time()


@app.on_event("startup")
async def _warmup_cv_stack() -> None:
    """Pre-import the heavy CV stack (fitz/numpy/cv2) at boot, in a background
    thread, so the FIRST real /cleanup request doesn't pay the ~2-4s cold-import
    tax. That tax otherwise lands directly in front of OCR extraction and reads
    as "OCR takes a long time to begin". Best-effort: on a lean install (no CV
    stack) it no-ops, and it never blocks /healthz or /readyz becoming live."""

    def _do_warmup() -> None:
        t = time.perf_counter()
        try:
            import fitz  # noqa: F401
            import numpy  # noqa: F401
            import cv2  # noqa: F401

            # Cap OpenCV's internal thread pool (the OMP/BLAS env vars don't reach it).
            # On a low-RAM / <1-vCPU box this trims per-thread scratch buffers with no
            # output change and no real speed cost. Best-effort: never fail warmup.
            try:
                cv2.setNumThreads(1)
            except Exception:  # noqa: BLE001
                pass

            log.info("cv stack warmed (fitz/numpy/cv2) in %.0fms", (time.perf_counter() - t) * 1000.0)
        except Exception as e:  # noqa: BLE001
            log.info("cv warmup skipped (CV stack absent): %s", e)

    # Fire-and-forget on the default executor — does not delay startup completion.
    asyncio.get_event_loop().run_in_executor(None, _do_warmup)

    # Visible runtime-evidence banner — proves the Python Document Engine started + which routes serve it.
    log.info(
        "\n===================================\n"
        "THE SK LEARNINGS PYTHON DOCUMENT ENGINE\n"
        "STATUS: STARTED\n"
        "PORT: %s\n"
        "===================================\n"
        "POST /process-document\n"
        "POST /build-document\n"
        "POST /ocr-document\n"
        "===================================",
        settings.port,
    )


@app.get("/healthz")
async def healthz():
    # `stale` = a .py under app/ was modified AFTER this process booted ⇒ the sidecar is running OLD code
    # and MUST be restarted (kill whatever holds :8002 first). `bootedAt` lets you confirm the restart took.
    cur = _latest_source_mtime()
    stale = cur > _BOOT_SRC_MTIME + 0.5
    return {
        "status": "ok",
        "engine": settings.engine,
        "port": settings.port,
        "stale": stale,
        "bootedAt": _BOOTED_AT,
        "sourceMtimeAtBoot": round(_BOOT_SRC_MTIME, 1),
        "currentSourceMtime": round(cur, 1),
    }


@app.get("/readyz")
async def readyz():
    return JSONResponse(status_code=200, content={"ready": True})


class CleanupRequest(BaseModel):
    storageKey: str
    mime: Optional[str] = None
    ocrJobId: Optional[str] = None
    owner: Optional[str] = None


@app.post("/cleanup")
async def cleanup(req: CleanupRequest):
    t0 = time.perf_counter()
    content, mime = await fetch_object(req.storageKey)
    t_fetched = time.perf_counter()
    cleaned, changed = await asyncio.get_event_loop().run_in_executor(
        None, clean_document, content, req.mime or mime, req.owner or "python"
    )
    log.info(
        "[cleanup-timing] /cleanup job=%s fetch_ms=%.0f clean_ms=%.0f total_ms=%.0f changed=%s",
        req.ocrJobId, (t_fetched - t0) * 1000.0,
        (time.perf_counter() - t_fetched) * 1000.0, (time.perf_counter() - t0) * 1000.0, changed,
    )
    if not changed:
        # Safe no-op: Node keeps the original bytes.
        return Response(status_code=200, headers={"X-Cleanup-Changed": "false"})
    return Response(
        content=cleaned,
        media_type=mime or "application/pdf",
        headers={"X-Cleanup-Changed": "true"},
    )


class ValidateStructureRequest(BaseModel):
    # The FINAL crop image already produced by the Node OCR pipeline (Node owns storage).
    cropStorageKey: str
    mime: Optional[str] = None
    isMcq: Optional[bool] = True
    # Node owns the real option count (from OCR); the validator only adds CV structure on top.
    optionCount: Optional[int] = 0


@app.post("/validate-structure")
async def validate_structure(req: ValidateStructureRequest):
    """STRUCTURAL VALIDATOR (CV only, no OCR). Given a crop image, report whether it is a COMPLETE
    question crop — content not cut at the edge, options present (Node count) or a diagram, not split
    across a column. Node calls this BEFORE persisting; an incomplete verdict ⇒ Node routes to review
    and never persists a broken crop. Degrades cleanly: `complete:null` when the CV stack is absent."""
    content, mime = await fetch_object(req.cropStorageKey)
    report = await asyncio.get_event_loop().run_in_executor(
        None, analyze_structure, content, req.mime or mime, bool(req.isMcq), int(req.optionCount or 0)
    )
    return JSONResponse(status_code=200, content=report)


class CleanCropRequest(BaseModel):
    # The FINAL crop image already produced by the Node OCR pipeline (Node owns storage).
    cropStorageKey: str
    mime: Optional[str] = None


@app.post("/clean-crop")
async def clean_crop(req: CleanCropRequest):
    """LEADING NUMBER / BADGE eraser on a SINGLE delivered crop (pixel-level, OCR-independent).

    Removes a question-number BADGE — circled / boxed / "NM"-tagged / plain / handwritten — that the
    token-based number strip cannot see (it is not OCR'd as a clean marker). Content-safe: only an
    isolated leading marker (a compact top-left block, or a single-line number with a real indent) is
    whitened; a stem that starts with a word, a figure, or an inline number is left untouched. The TS
    crop path calls this so EVERY delivered crop is content-only no matter which engine built it.

    WATERMARK removal is intentionally NOT performed here. Heavy watermarks are cleaned by the uploader
    BEFORE upload, so the OCR workflow spends zero CPU trying to lift them — and a faint-background lift on
    every crop risked touching low-contrast content. Page CHROME (repeated header/footer/page-number/border
    /banner) is still removed document-wide and content-safely upstream by the structure engine's repeated-
    region detectors (repeated_chrome + chrome_pixels), which only clip the top/bottom chrome bands and
    never delete body pixels — so delivered crops stay chrome-free without any per-crop watermark pass.
    Returns {erased, imageBase64}; degrades to erased=false (original bytes) on any problem."""
    import base64 as _b64

    from .structure_engine import leading_marker, seal_shapes

    content, _mime = await fetch_object(req.cropStorageKey)

    def _run():
        png, erased = leading_marker.erase_png(content)
        # SOLID "N NM" seal badge that erase_png (built for outline/plain badges) misses — whiten the
        # top-left seal so the crop is content-only (the UI owns the number).
        png, seal_erased = seal_shapes.erase_top_left_seal_png(png)
        return (erased or seal_erased), _b64.b64encode(png).decode("ascii")

    erased, img_b64 = await asyncio.get_event_loop().run_in_executor(None, _run)
    return JSONResponse(status_code=200, content={"erased": bool(erased), "imageBase64": img_b64})


@app.post("/analyze-document")
async def analyze_document_route(payload: dict):
    """STRUCTURAL INTELLIGENCE ENGINE (no OCR, no AI). TS hands Python the per-page OCR
    tokens (words + number-markers) it ALREADY produced, plus page render keys; Python
    reasons about DOCUMENT STRUCTURE — question ownership, cross-column/cross-page MERGES,
    sequence + page-role validation — and returns a PROPOSAL. TS validates it and is the
    only authority that persists. Python never crops, never splits, never guesses; an
    uncertain ownership routes to review. Pure-geometry today (Phase 1); the CV detectors
    (diagram/graph/table/equation/chem) reuse the same cv2/numpy stack in Phase 2.

    Request body (JSON):
      { documentId, pages: [ { index, width, height, pageImageKey?,
          words: [{text,x0,y0,x1,y1,conf}],
          markers: [{num,x0,y0,x1,y1,punct}] } ] }
    Response: the DocumentAnalysis proposal (see structure_engine.models)."""
    result = await asyncio.get_event_loop().run_in_executor(None, analyze_document, payload)
    return JSONResponse(status_code=200, content=result)


class DocumentRequest(BaseModel):
    # TS owns storage — it hands Python the document's storage key; Python fetches it and runs the
    # COMPLETE lifecycle. There is no separate "OCR call": OCR is the engine's first internal stage.
    storageKey: str
    documentId: Optional[str] = None
    mime: Optional[str] = None


@app.post("/process-document")
async def process_document_route(req: DocumentRequest):
    """THE PYTHON DOCUMENT ENGINE — the single production entry. TS hands Python the uploaded document;
    Python runs the COMPLETE lifecycle in one pass — OCR router (PyMuPDF/PaddleOCR/TrOCR, one engine per
    region) → ownership graph → completeness → Visual Intelligence (diagram/graph/equation/chem) → crop
    construction → repair → validation → Stage 1 + Stage 2 N=N=C → delivery decision — and returns the
    FINAL result (per-question crops + counts + `deliver`). TS stores it VERBATIM when deliver is true;
    when deliver is false the WHOLE upload routes to review. TS performs NO OCR, counting, cropping,
    merging, dedup, or modification — it is storage only. Never two engines, never TS after Python."""
    content, mime = await fetch_object(req.storageKey)
    from .ocr_engine import process_document

    result = await asyncio.get_event_loop().run_in_executor(
        None, process_document, content, req.documentId or req.storageKey
    )
    return JSONResponse(status_code=200, content=result)


@app.post("/ocr-document")
async def ocr_document_route(req: DocumentRequest):
    """INTERNAL / DIAGNOSTIC — the OCR-router stage in isolation (per-page words + routing audit), for
    inspecting how pages were classified/routed. NOT the production path: production is /process-document,
    which runs OCR as its first internal stage and continues to the delivery decision. TS does not call
    this; it exists so the OCR stage can be validated independently."""
    content, mime = await fetch_object(req.storageKey)
    from .ocr_engine import route_document

    result = await asyncio.get_event_loop().run_in_executor(
        None, route_document, content, req.documentId or req.storageKey
    )
    return JSONResponse(status_code=200, content=result)


@app.post("/build-document")
async def build_document_route(payload: dict):
    """END-TO-END BUILD — Python as the single document engine. Same input as /analyze-document
    PLUS `imageBase64` per page (the render, same coord space as the word boxes). Runs ownership →
    completeness → Visual Intelligence (CV on renders) → crop construction → repair → validation →
    Stage 1 + Stage 2 N=N=C, returning the per-question crop PNGs (base64) + a single `deliver` flag.
    TS only STORES the returned crops when `deliver` is true; otherwise the document routes to review.
    Python never persists; TS never modifies Python output."""
    from .structure_engine.document_builder import build_document

    result = await asyncio.get_event_loop().run_in_executor(None, build_document, payload)
    return JSONResponse(status_code=200, content=result)
