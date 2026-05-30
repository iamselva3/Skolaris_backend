"""Engine factory. Selects the handwriting recognizer from HW_OCR_MODEL.

Heavy ML deps (paddle/torch) are imported lazily inside their modules so the
default 'stub' engine runs with no ML stack installed.
"""
from ..config import settings
from .base import HandwritingEngine


def build_engine() -> HandwritingEngine:
    model = settings.model
    if model == "stub":
        from .stub import StubEngine

        return StubEngine()
    if model == "paddle":
        from .paddle_engine import PaddleEngine

        return PaddleEngine()
    if model == "trocr":
        from .trocr_engine import TrocrEngine

        return TrocrEngine()
    raise RuntimeError(f"Unknown HW_OCR_MODEL '{model}' (expected stub|paddle|trocr)")
