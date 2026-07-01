"""Download an uploaded object via the backend read-proxy — the SAME convention
the Node read-proxy and frontend use:

    GET {base}/storage/v1/b/{bucket}/o/{urlencoded-key}?alt=media

READ-ONLY. The cleanup service NEVER writes storage — Node owns storage and
persists the cleaned bytes returned in the HTTP response.
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
    return _MIME_BY_EXT.get(ext, "application/octet-stream")


async def fetch_object(storage_key: str) -> tuple[bytes, str]:
    url = (
        f"{settings.read_base_url}/storage/v1/b/"
        f"{quote(settings.bucket, safe='')}/o/{quote(storage_key, safe='')}?alt=media"
    )
    async with httpx.AsyncClient(timeout=60) as client:
        res = await client.get(url)
    if res.status_code != 200:
        raise RuntimeError(f"storage fetch {res.status_code} for {url}")
    mime = res.headers.get("content-type") or _infer_mime(storage_key)
    return res.content, mime
