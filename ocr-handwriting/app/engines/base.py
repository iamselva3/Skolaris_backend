"""Engine contract. An engine turns the uploaded bytes (image or PDF) into a
single combined plain-text transcript + an overall 0..1 confidence + a provider
label. The worker then runs the shared parser to produce drafts, so all engines
yield the same draft shape.
"""
from typing import Protocol, Tuple


class HandwritingEngine(Protocol):
    name: str

    def warm(self) -> None:
        """Eagerly load models so /readyz can gate traffic until ready."""

    def recognize(self, content: bytes, mime: str) -> Tuple[str, float, str]:
        """Return (combined_text, overall_confidence_0_1, provider_used)."""
        ...
