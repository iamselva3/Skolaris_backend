"""Job handler: storage download → engine OCR → shared parser → HMAC callback.

Mirrors scripts/ocr-worker.ts: on success POST drafts; on failure POST an
errorMessage (empty drafts) so the upload flips to FAILED, then re-raise so
BullMQ applies its retry/backoff. The NestJS callback is idempotent, so a
retried job that already delivered is a benign no-op (alreadyProcessed).
"""
import asyncio
import logging
from typing import Any, Dict

from .callback import build_payload, post_callback
from .config import settings
from .engines.base import HandwritingEngine
from .parser import Draft, parse_drafts
from .storage import fetch_object

log = logging.getLogger("ocr-handwriting.worker")


async def handle_job(engine: HandwritingEngine, data: Dict[str, Any]) -> None:
    ocr_job_id = data.get("ocrJobId")
    storage_key = data.get("storageKey")
    upload_id = data.get("uploadId")
    if not ocr_job_id or not storage_key:
        log.error("invalid handwriting job payload: %s", data)
        return

    log.info("handwriting job ocrJob=%s upload=%s accepted", ocr_job_id, upload_id)
    try:
        content, mime = await fetch_object(storage_key)
        # OCR is CPU-bound — keep it off the event loop.
        text, conf, provider = await asyncio.get_event_loop().run_in_executor(
            None, engine.recognize, content, mime
        )
        drafts = parse_drafts(text, conf, settings.max_drafts)
        if not drafts:
            snippet = text.strip()[:2000] or "(handwriting OCR produced no extractable text)"
            drafts = [Draft(position=0, text=snippet, detectedType="DESCRIPTIVE", confidence=conf)]

        result = await post_callback(build_payload(ocr_job_id, provider, conf, drafts))
        already = (result or {}).get("data", {}).get("alreadyProcessed")
        log.info(
            "handwriting job ocrJob=%s delivered %d draft(s) provider=%s alreadyProcessed=%s",
            ocr_job_id, len(drafts), provider, already,
        )
    except Exception as exc:  # noqa: BLE001 - report failure via the shared contract
        log.exception("handwriting job ocrJob=%s FAILED", ocr_job_id)
        try:
            await post_callback(
                build_payload(ocr_job_id, engine.name, 0.0, [], error_message=str(exc))
            )
        except Exception:  # noqa: BLE001
            log.exception("failed to post error callback for ocrJob=%s", ocr_job_id)
        raise  # let BullMQ retry per its backoff policy
