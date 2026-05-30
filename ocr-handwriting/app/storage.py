"""Download an uploaded object using the SAME GCS-compatible URL convention as
the Node engine (src/shared/ocr-engine/ocr-engine.ts fetchObjectBytes):

    GET {endpoint}/download/storage/v1/b/{bucket}/o/{urlencoded-key}?alt=media

Works against fake-gcs-server (dev, unauthenticated) and public-read GCS. For
authenticated prod GCS, swap in google-cloud-storage with ADC here only — the
rest of the service is unaffected.
"""
from urllib.parse import quote

import httpx

from .config import settings

_MIME_BY_EXT = {
    "pdf": "application/pdf",
    "png": "image/png",
    "webp": "image/webp",
    "heic": "image/heic",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
}


def _infer_mime(storage_key: str) -> str:
    ext = storage_key.rsplit(".", 1)[-1].lower() if "." in storage_key else ""
    return _MIME_BY_EXT.get(ext, "image/jpeg")


async def fetch_object(storage_key: str) -> tuple[bytes, str]:
    url = (
        f"{settings.gcs_endpoint}/download/storage/v1/b/"
        f"{quote(settings.gcs_bucket, safe='')}/o/{quote(storage_key, safe='')}?alt=media"
    )
    async with httpx.AsyncClient(timeout=60) as client:
        res = await client.get(url)
    if res.status_code != 200:
        raise RuntimeError(f"Storage fetch {res.status_code} for {url}")
    mime = res.headers.get("content-type") or _infer_mime(storage_key)
    return res.content, mime
