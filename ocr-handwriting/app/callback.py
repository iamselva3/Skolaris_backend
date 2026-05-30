"""POST results back to the NestJS API using the EXISTING HMAC-signed callback
contract (OcrCallbackDto + HmacAuthGuard).

CRITICAL: the API verifies HMAC-SHA256 over the EXACT raw request body bytes
(req.rawBody), NOT a re-serialized JSON. So we serialize the payload ONCE, sign
those exact bytes, and send THOSE exact bytes — never re-encode between signing
and sending. This mirrors scripts/ocr-worker.ts postCallback byte-for-byte.
"""
import hashlib
import hmac
import json
from typing import Any, List, Optional

import httpx

from .config import settings
from .parser import Draft


def _draft_to_dict(d: Draft) -> dict:
    out: dict[str, Any] = {"position": d.position, "text": d.text}
    if d.detectedType is not None:
        out["detectedType"] = d.detectedType
    if d.options:
        out["options"] = [{"label": o.label, "isCorrect": o.isCorrect} for o in d.options]
    if d.confidence is not None:
        out["confidence"] = round(float(d.confidence), 3)
    return out


def build_payload(
    ocr_job_id: str,
    provider_used: str,
    overall_confidence: float,
    drafts: List[Draft],
    error_message: Optional[str] = None,
) -> dict:
    payload: dict[str, Any] = {
        "ocrJobId": ocr_job_id,
        "providerUsed": provider_used[:40],
        "overallConfidence": max(0.0, min(1.0, round(float(overall_confidence), 3))),
        "drafts": [_draft_to_dict(d) for d in drafts],
    }
    if error_message:
        payload["errorMessage"] = error_message[:2000]
        payload["drafts"] = []
    return payload


def _sign(body: bytes) -> str:
    return hmac.new(settings.callback_secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


async def post_callback(payload: dict) -> dict:
    # Serialize ONCE; sign and send the identical bytes.
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    signature = _sign(body)
    async with httpx.AsyncClient(timeout=settings.callback_timeout) as client:
        res = await client.post(
            settings.callback_url,
            content=body,
            headers={"content-type": "application/json", "x-ocr-signature": signature},
        )
    if res.status_code != 200:
        raise RuntimeError(f"Callback {res.status_code}: {res.text[:400]}")
    try:
        return res.json()
    except Exception:  # noqa: BLE001 - benign; the API always returns JSON on 200
        return {}


# asdict import kept for parity with dataclass payloads if a caller passes them.
_ = (asdict, is_dataclass)
