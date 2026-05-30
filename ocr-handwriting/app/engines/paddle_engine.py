"""PaddleOCR engine (HW_OCR_MODEL=paddle) — RECOMMENDED real engine.

PaddleOCR does text DETECTION + RECOGNITION in one pass (handles multi-line
pages directly), is CPU-friendly, and exposes per-line confidence. Heavy deps
(paddleocr, paddlepaddle, pdf2image, pillow) are imported lazily so the default
stub engine doesn't require them. PDF rasterization needs poppler (installed in
the Docker image).
"""
from io import BytesIO
from typing import List, Tuple

from ..config import settings


class PaddleEngine:
    name = "paddle-hw"

    def __init__(self) -> None:
        self._ocr = None

    def warm(self) -> None:
        if self._ocr is None:
            from paddleocr import PaddleOCR

            self._ocr = PaddleOCR(
                use_angle_cls=True,
                lang="en",
                show_log=False,
                use_gpu=(settings.device == "cuda"),
            )

    def _pages(self, content: bytes, mime: str) -> List:
        from PIL import Image

        if mime == "application/pdf":
            from pdf2image import convert_from_bytes

            return convert_from_bytes(content, dpi=settings.pdf_dpi)
        return [Image.open(BytesIO(content)).convert("RGB")]

    def recognize(self, content: bytes, mime: str) -> Tuple[str, float, str]:
        self.warm()
        import numpy as np

        pages = self._pages(content, mime)
        lines: List[str] = []
        confs: List[float] = []
        for img in pages:
            result = self._ocr.ocr(np.array(img), cls=True)
            for block in result or []:
                for line in block or []:
                    # line == [box, (text, confidence)]
                    try:
                        text, conf = line[1][0], float(line[1][1])
                    except (IndexError, TypeError, ValueError):
                        continue
                    if text:
                        lines.append(text)
                        confs.append(conf)
            lines.append("")  # blank line == page break for the parser
        text = "\n".join(lines)
        overall = sum(confs) / len(confs) if confs else 0.0
        provider = f"paddle-hw:pdf({len(pages)}p)" if mime == "application/pdf" else "paddle-hw"
        return text, overall, provider
