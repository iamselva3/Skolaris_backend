"""Engine contract. An engine turns the uploaded bytes (image or PDF) into a
single combined plain-text transcript + an overall 0..1 confidence + a provider
label. The worker then runs the shared parser to produce drafts, so all engines
yield the same draft shape.

The optional `recognize_structured` method (Slice 2.2) returns per-page text
PLUS per-word bounding boxes so the Node-side column-reorder + parseDrafts can
run on real PaddleOCR output — the path that handles real coaching-centre
papers correctly. Engines that don't implement it (stub, trocr default mode)
fall back to flat recognize().
"""
from typing import Dict, List, Protocol, Tuple


class WordBox(Dict):
    """Per-word OCR output. Keys: text, x0, y0, x1, y1, conf (0..1)."""


class PageOcr(Dict):
    """Per-page structured output. Keys: pageNumber (int), text (str),
    confidence (float, 0..1), words (List[WordBox])."""


class HandwritingEngine(Protocol):
    name: str

    def warm(self) -> None:
        """Eagerly load models so /readyz can gate traffic until ready."""

    def recognize(self, content: bytes, mime: str) -> Tuple[str, float, str]:
        """Return (combined_text, overall_confidence_0_1, provider_used)."""
        ...

    def recognize_structured(self, content: bytes, mime: str) -> Tuple[List[PageOcr], str]:
        """Optional. Return (pages, provider_used) where each page has its own
        text + per-word bboxes. Engines without ML support raise NotImplementedError;
        the dispatcher falls back to flat recognize() in that case.
        """
        ...
