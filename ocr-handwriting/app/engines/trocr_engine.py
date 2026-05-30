"""TrOCR engine (HW_OCR_MODEL=trocr) — alternative to PaddleOCR.

TrOCR (microsoft/trocr-base-handwritten) is a strong HANDWRITING recognizer but
is a SINGLE-LINE/REGION model with NO built-in detection. A production setup
should segment text lines first (e.g. PaddleOCR detection or CRAFT) and feed
each line to TrOCR. This baseline runs each page as one region — acceptable for
single-block notes, weak for dense multi-line sheets; prefer 'paddle' there.

Heavy deps (torch, transformers, pdf2image, pillow) are imported lazily.
"""
from io import BytesIO
from typing import List, Tuple

from ..config import settings


class TrocrEngine:
    name = "trocr"

    def __init__(self) -> None:
        self._processor = None
        self._model = None
        self._device = "cpu"

    def warm(self) -> None:
        if self._model is None:
            from transformers import TrOCRProcessor, VisionEncoderDecoderModel

            model_name = "microsoft/trocr-base-handwritten"
            self._processor = TrOCRProcessor.from_pretrained(model_name)
            self._model = VisionEncoderDecoderModel.from_pretrained(model_name)
            self._device = "cuda" if settings.device == "cuda" else "cpu"
            self._model.to(self._device)

    def _pages(self, content: bytes, mime: str) -> List:
        from PIL import Image

        if mime == "application/pdf":
            from pdf2image import convert_from_bytes

            return convert_from_bytes(content, dpi=settings.pdf_dpi)
        return [Image.open(BytesIO(content)).convert("RGB")]

    def recognize(self, content: bytes, mime: str) -> Tuple[str, float, str]:
        self.warm()
        pages = self._pages(content, mime)
        out: List[str] = []
        for img in pages:
            pixel_values = self._processor(images=img, return_tensors="pt").pixel_values.to(self._device)
            generated = self._model.generate(pixel_values)
            text = self._processor.batch_decode(generated, skip_special_tokens=True)[0]
            out.append(text)
            out.append("")  # page break
        text = "\n".join(out)
        # TrOCR does not expose a calibrated confidence; report a fixed estimate
        # so the low-confidence UI hint still behaves reasonably.
        provider = f"trocr:pdf({len(pages)}p)" if mime == "application/pdf" else "trocr"
        return text, 0.6, provider
