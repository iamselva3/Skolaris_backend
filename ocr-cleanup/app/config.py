"""Runtime configuration for the Document Cleanup microservice.

All values come from env, mirroring ocr-handwriting so a single compose env block
configures both. Nothing here is SKOLARIS-specific beyond the read-proxy convention.
No cleanup thresholds live here — the engine derives everything from the document
itself (no BACKGROUND_THRESHOLD / HEADER_Y / DIVIDER_X / WATERMARK_ALPHA).
"""
import os


def _clean_base(url: str) -> str:
    return url.rstrip("/")


class Settings:
    # Object read-proxy — the SAME convention the Node read-proxy + frontend use:
    #   {base}/storage/v1/b/{bucket}/o/{urlencoded-key}?alt=media
    read_base_url: str = _clean_base(
        os.environ.get("STORAGE_READ_BASE_URL") or "http://localhost:3000/api"
    )
    bucket: str = (
        os.environ.get("AWS_S3_BUCKET") or os.environ.get("GCS_BUCKET") or "skolaris-uploads"
    )

    # 'identity' (default) = safe pass-through; 'cv' = the real protect-mask engine
    # (only when the CV stack is installed AND validated in-runtime).
    engine: str = os.environ.get("CLEANUP_ENGINE", "identity").lower()
    port: int = int(os.environ.get("PORT", "8002"))

    # Server-side wall-clock budget for a whole-document CV pass. Set just under
    # the Node client cap (CLEANUP_ENGINE_TIMEOUT_MS, default 15000) so Python
    # bails cleanly (returns ORIGINAL bytes) BEFORE the client aborts — it can
    # never burn CPU after the client has given up. Golden rule: never burn for
    # zero output.
    max_ms: int = int(os.environ.get("CLEANUP_MAX_MS", "13000"))

    # Working resolution cap for the CV pass. Cleanup renders each page to a
    # pixmap, detects artifacts, lifts background, and re-inserts the result —
    # render + connected-components + encode all scale with pixel count. The
    # downstream OCR engine renders at ~144 DPI effective, so cleaning above that
    # buys nothing but time; cap the working DPI here (was effectively ~200-212).
    work_dpi: int = int(os.environ.get("CLEANUP_WORK_DPI", "150"))


settings = Settings()
