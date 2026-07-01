"""
TrOCR adapter — HANDWRITTEN regions only → OcrToken[]. Never the whole page.

TrOCR (transformers + torch) is a transformer recogniser, not a detector: it reads ONE cropped
region into a string. So it runs strictly on the handwritten regions the region classifier found —
handwritten question numbers, option labels, teacher corrections, annotations — and the region box
IS the token box. Guarded like Paddle: a missing backend raises EngineUnavailable and the router
degrades that page (KEEP PIXELS + flag) rather than reading handwriting with a printed-text engine.

Critical: this adapter only READS handwriting. It NEVER decides a handwritten token is a question
number — sequence/ownership/layout alignment is the structure engine's call. Handwriting is never
auto-promoted here.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, List

from .models import EngineUnavailable, OcrToken, Region

if TYPE_CHECKING:
    import numpy as np

_PROC = None
_MODEL = None
_TROCR_TRIED = False
_TROCR_ERR = ""
# Handwritten model (vs the printed TrOCR weights). Override via env if a local/cached path is used.
_MODEL_NAME = "microsoft/trocr-base-handwritten"


def trocr_available() -> bool:
    """True if transformers+torch import and the handwritten model loads. Probed once, cached."""
    global _PROC, _MODEL, _TROCR_TRIED, _TROCR_ERR
    if _TROCR_TRIED:
        return _MODEL is not None
    _TROCR_TRIED = True
    try:
        import os

        from transformers import TrOCRProcessor, VisionEncoderDecoderModel  # type: ignore

        name = os.environ.get("TROCR_MODEL", _MODEL_NAME)
        _PROC = TrOCRProcessor.from_pretrained(name)
        _MODEL = VisionEncoderDecoderModel.from_pretrained(name)
        _MODEL.eval()
    except Exception as e:  # noqa: BLE001
        _PROC = _MODEL = None
        _TROCR_ERR = str(e)
    return _MODEL is not None


def extract_handwritten(image: "np.ndarray", index: int, scale: float, regions: List[Region]) -> List[OcrToken]:
    """Read each HANDWRITTEN region into one token (region box = token box). Pixel→points via `scale`.
    Raises EngineUnavailable if torch/transformers are not installed — the router degrades the page."""
    if not regions:
        return []
    if not trocr_available():
        raise EngineUnavailable("trocr", _TROCR_ERR)
    import torch  # local
    from PIL import Image  # local

    tokens: List[OcrToken] = []
    for r in regions:
        x0, y0 = int(r.x0 / scale), int(r.y0 / scale)
        x1, y1 = int(r.x1 / scale), int(r.y1 / scale)
        sub = image[max(0, y0):max(0, y1), max(0, x0):max(0, x1)]
        if not sub.size:
            continue
        pil = Image.fromarray(sub).convert("RGB")
        pixel_values = _PROC(images=pil, return_tensors="pt").pixel_values  # type: ignore[union-attr]
        with torch.no_grad():
            generated = _MODEL.generate(pixel_values)  # type: ignore[union-attr]
        text = _PROC.batch_decode(generated, skip_special_tokens=True)[0].strip()  # type: ignore[union-attr]
        if not text:
            continue
        tokens.append(
            OcrToken(
                text=text,
                x0=r.x0,
                y0=r.y0,
                x1=r.x1,
                y1=r.y1,
                page=index,
                conf=max(0.0, min(1.0, r.conf)) or 0.5,  # region classifier confidence as a proxy
                source="trocr",
            )
        )
    return tokens
