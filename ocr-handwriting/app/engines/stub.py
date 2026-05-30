"""Dependency-free stub engine (HW_OCR_MODEL=stub, the default).

Returns a canned multi-question transcript so the FULL pipeline — queue consume
→ engine → parser → HMAC callback → READY_FOR_REVIEW — is verifiable locally
without downloading any ML models. This is the handwriting analogue of the
Node-side ocr-mock worker. Swap to paddle/trocr in real environments.
"""
from typing import Tuple

_CANNED = (
    "1) Define Newton's second law and give its formula.\n"
    "2) A body of mass 2 kg accelerates at 3 m/s^2. Find the net force.\n"
    "a) 5 N\n"
    "b) 6 N\n"
    "c) 1.5 N\n"
    "d) 0.67 N\n"
    "3) State whether the following is true or false: momentum is conserved in an isolated system.\n"
)


class StubEngine:
    name = "stub-hw"

    def warm(self) -> None:  # nothing to load
        return None

    def recognize(self, content: bytes, mime: str) -> Tuple[str, float, str]:
        provider = "stub-hw:pdf" if mime == "application/pdf" else "stub-hw"
        return _CANNED, 0.55, provider
