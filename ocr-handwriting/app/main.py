"""FastAPI entrypoint for the SKOLARIS handwriting OCR microservice.

Responsibilities:
  - consume the BullMQ 'ocr.handwriting' queue (the Node side routes to it),
  - expose /healthz (liveness) and /readyz (gated on model warm-up),
  - expose POST /ocr/extract for manual/sync testing (does NOT post a callback).

It is OPTIONAL: the Node pipeline runs fine without it (HANDWRITING_OCR_ENABLED
off). Bring it up with `docker compose --profile handwriting up`.
"""
import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .callback import _draft_to_dict
from .config import settings
from .engines import build_engine
from .parser import parse_drafts
from .storage import fetch_object
from .worker import handle_job

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("ocr-handwriting")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.validate()
    engine = build_engine()
    app.state.engine = engine
    app.state.ready = False

    async def _warm() -> None:
        try:
            await asyncio.get_event_loop().run_in_executor(None, engine.warm)
            app.state.ready = True
            log.info("engine '%s' warmed; ready", engine.name)
        except Exception:  # noqa: BLE001
            log.exception("engine warm-up failed")

    warm_task = asyncio.create_task(_warm())

    # Start the BullMQ consumer (official `bullmq` python client, protocol-compatible).
    from bullmq import Worker

    async def _process(job, token=None):  # noqa: ANN001 - bullmq passes (job, token)
        await handle_job(engine, job.data)

    worker = Worker(settings.queue_name, _process, {"connection": settings.redis_url})
    app.state.worker = worker
    log.info("consuming BullMQ queue '%s' at %s (model=%s)", settings.queue_name, settings.redis_url, settings.model)

    try:
        yield
    finally:
        warm_task.cancel()
        await worker.close()


app = FastAPI(title="SKOLARIS Handwriting OCR", lifespan=lifespan)


@app.get("/healthz")
async def healthz():
    return {
        "status": "ok",
        "model": settings.model,
        "device": settings.device,
        "queue": settings.queue_name,
    }


@app.get("/readyz")
async def readyz():
    ready = bool(getattr(app.state, "ready", False))
    return JSONResponse(status_code=200 if ready else 503, content={"ready": ready})


class ExtractRequest(BaseModel):
    storageKey: str
    mime: Optional[str] = None


@app.post("/ocr/extract")
async def extract(req: ExtractRequest):
    """Synchronous, manual-mode extraction. Returns drafts WITHOUT posting the
    callback — for testing the engine in isolation."""
    content, mime = await fetch_object(req.storageKey)
    text, conf, provider = await asyncio.get_event_loop().run_in_executor(
        None, app.state.engine.recognize, content, req.mime or mime
    )
    drafts = parse_drafts(text, conf, settings.max_drafts)
    return {
        "providerUsed": provider,
        "overallConfidence": round(conf, 3),
        "drafts": [_draft_to_dict(d) for d in drafts],
    }


@app.post("/ocr/extract-structured")
async def extract_structured(req: ExtractRequest):
    """Slice 2.2 — printed-paper PaddleOCR path. Returns per-page text + per-word
    bounding boxes so the Node side can run column reorder + page classification
    + parseDrafts itself. The HEAVY work (OCR) happens here; the smart work
    (layout / parsing) stays in Node where it's tested.

    Engines that lack `recognize_structured` (the stub) return HTTP 501; the
    Node dispatcher then degrades to the existing tesseract path so callers
    are never silently downgraded.
    """
    content, mime = await fetch_object(req.storageKey)
    engine = app.state.engine
    if not hasattr(engine, "recognize_structured"):
        return JSONResponse(
            status_code=501,
            content={
                "error": "structured_unsupported",
                "engine": engine.name,
                "message": "This engine does not implement recognize_structured(); use HW_OCR_MODEL=paddle.",
            },
        )
    pages, provider = await asyncio.get_event_loop().run_in_executor(
        None, engine.recognize_structured, content, req.mime or mime
    )
    overall = sum(p["confidence"] for p in pages) / len(pages) if pages else 0.0

    # Phase B — flatten per-page typed regions into a top-level regions[]
    # array with a global readingOrder index. The flat top-level shape is
    # what the Node side and Phase C consumers will read; the per-page field
    # is dropped from the wire so we never double-serialize the data.
    regions: list = []
    for page in pages:
        page_regions = page.pop("regions", None) or []
        for r in page_regions:
            r["readingOrder"] = len(regions)
            regions.append(r)

    return {
        "providerUsed": provider,
        "overallConfidence": round(overall, 3),
        "pages": pages,
        "regions": regions,
    }
