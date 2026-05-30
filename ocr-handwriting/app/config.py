"""Runtime configuration for the handwriting OCR microservice.

All values come from env, mirroring the Node side so a single secret store /
compose env block configures both. Nothing here is SKOLARIS-specific beyond the
shared callback contract.
"""
import os


def _clean_base(url: str) -> str:
    return url.rstrip("/")


class Settings:
    # Queue (same Redis + queue name the Node producer enqueues onto).
    redis_url: str = os.environ.get("REDIS_URL", "redis://localhost:6379")
    queue_name: str = os.environ.get("HW_OCR_QUEUE_NAME", "ocr.handwriting")

    # Callback back into the NestJS API — the EXISTING HMAC-signed contract.
    callback_url: str = os.environ.get(
        "OCR_CALLBACK_URL", "http://localhost:3000/api/internal/ocr/callback"
    )
    callback_secret: str = os.environ.get("OCR_CALLBACK_SECRET", "")
    callback_timeout: float = float(os.environ.get("HW_OCR_CALLBACK_TIMEOUT", "30"))

    # Object storage (same GCS-compatible download convention the Node engine uses).
    gcs_bucket: str = os.environ.get("GCS_BUCKET", "skolaris-uploads")
    gcs_endpoint: str = _clean_base(
        os.environ.get("GCS_API_ENDPOINT") or os.environ.get("GCS_PUBLIC_HOST") or "http://localhost:4443"
    )

    # Engine selection. 'stub' is dependency-free and used for contract tests;
    # 'paddle' (recommended) and 'trocr' are the real handwriting recognizers.
    model: str = os.environ.get("HW_OCR_MODEL", "stub").lower()
    device: str = os.environ.get("HW_OCR_DEVICE", "cpu").lower()
    pdf_dpi: int = int(os.environ.get("HW_OCR_PDF_DPI", "200"))
    max_drafts: int = int(os.environ.get("HW_OCR_MAX_DRAFTS", "20"))

    port: int = int(os.environ.get("PORT", "8001"))

    def validate(self) -> None:
        if len(self.callback_secret) < 16:
            raise RuntimeError(
                "OCR_CALLBACK_SECRET missing or too weak (must be >= 16 chars; must match the API)."
            )


settings = Settings()
