"""
PaddleOCR adapter — PRINTED regions of scanned/mixed pages → OcrToken[].

Guarded exactly like the CV stack: the heavy import (paddleocr / paddlepaddle) lives inside the
call, and a missing backend raises EngineUnavailable so the ROUTER degrades the page (KEEP PIXELS +
flag) instead of substituting another engine. The PaddleOCR singleton is built once and reused
(model load is seconds); detection+recognition return pixel boxes which we map back to PDF points
via `scale` (points-per-pixel = page_height_pts / render_height_px) so tokens land in the same
coordinate space as the digital text layer and the crop builder.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, List, Optional

from .models import EngineUnavailable, OcrToken, Region

if TYPE_CHECKING:
    import numpy as np

_PADDLE = None          # cached PaddleOCR instance
_PADDLE_TRIED = False   # so we only pay the import/availability probe once
_PADDLE_ERR = ""


def paddle_available() -> bool:
    """True if paddleocr can be imported + a singleton built. Probed once, cached."""
    global _PADDLE, _PADDLE_TRIED, _PADDLE_ERR
    if _PADDLE_TRIED:
        return _PADDLE is not None
    _PADDLE_TRIED = True
    try:
        from paddleocr import PaddleOCR  # type: ignore

        # English print + angle classifier; det+rec on. show_log off to keep the sidecar log clean.
        _PADDLE = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
    except Exception as e:  # noqa: BLE001
        _PADDLE = None
        _PADDLE_ERR = str(e)
    return _PADDLE is not None


def extract_printed(
    image: "np.ndarray",
    index: int,
    scale: float,
    regions: Optional[List[Region]] = None,
) -> List[OcrToken]:
    """Recognise PRINTED text. If `regions` is given, OCR only those crops (one engine per region);
    otherwise OCR the whole image (scanned page with no handwritten split). Pixel boxes → PDF points
    via `scale`. Raises EngineUnavailable if paddleocr is not installed — the router degrades the page."""
    if not paddle_available():
        raise EngineUnavailable("paddle", _PADDLE_ERR)
    import numpy as np  # local — only when actually running OCR

    crops: List[tuple] = []  # (sub_image, offset_x_px, offset_y_px)
    if regions:
        for r in regions:
            x0, y0 = int(r.x0 / scale), int(r.y0 / scale)
            x1, y1 = int(r.x1 / scale), int(r.y1 / scale)
            sub = image[max(0, y0):max(0, y1), max(0, x0):max(0, x1)]
            if sub.size:
                crops.append((sub, x0, y0))
    else:
        crops.append((image, 0, 0))

    tokens: List[OcrToken] = []
    for sub, off_x, off_y in crops:
        result = _PADDLE.ocr(sub, cls=True)  # type: ignore[union-attr]
        # PaddleOCR returns [ [ [box4pts], (text, conf) ], ... ] (nested one level per image).
        for line in (result or []):
            for entry in (line or []):
                box, (text, conf) = entry[0], entry[1]
                txt = (text or "").strip()
                if not txt:
                    continue
                xs = [p[0] + off_x for p in box]
                ys = [p[1] + off_y for p in box]
                tokens.append(
                    OcrToken(
                        text=txt,
                        x0=min(xs) * scale,
                        y0=min(ys) * scale,
                        x1=max(xs) * scale,
                        y1=max(ys) * scale,
                        page=index,
                        conf=float(conf),
                        source="paddle",
                    )
                )
    return tokens
