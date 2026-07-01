"""
OCR-engine data model — pure stdlib (no fitz/cv2/torch here so it imports anywhere).

The OcrToken is the SINGLE unit the whole Python document engine reads. Whatever engine
produced it (PyMuPDF / PaddleOCR / TrOCR), a token is identical in shape, so the structure
engine never needs to know which engine ran. `source` is kept for diagnostics + audit only;
the structure engine MUST NOT branch on it (one question = one owner = one crop, regardless
of how its text was read).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional


class PageKind(str, Enum):
    """How a page must be OCR-routed. Decided by the page router from the PDF itself."""

    DIGITAL = "DIGITAL"      # real text layer present → PyMuPDF (no model)
    SCANNED = "SCANNED"      # image-only page → region split → PaddleOCR / TrOCR
    MIXED = "MIXED"          # text layer AND large raster region(s) → both, per region
    EMPTY = "EMPTY"          # no extractable content → no tokens, flagged


class RegionKind(str, Enum):
    """What a sub-page region contains, deciding which single engine reads it."""

    PRINTED = "PRINTED"          # machine print → PaddleOCR
    HANDWRITTEN = "HANDWRITTEN"  # handwriting → TrOCR (region-only, never whole page)


@dataclass
class OcrToken:
    """One recognised word with its page-space box. Coordinates are in PDF points (same space
    the structure engine + crop builder use), top-left origin, y growing downward."""

    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    page: int            # 0-based page index
    conf: float = 1.0    # 0..1; 1.0 for a clean digital text layer
    source: str = "pymupdf"  # 'pymupdf' | 'paddle' | 'trocr' — diagnostics only

    def to_word(self) -> dict:
        """The `words` shape the structure engine consumes ({text,x0,y0,x1,y1,conf})."""
        return {
            "text": self.text,
            "x0": round(self.x0, 2),
            "y0": round(self.y0, 2),
            "x1": round(self.x1, 2),
            "y1": round(self.y1, 2),
            "conf": round(self.conf, 4),
        }


@dataclass
class Region:
    """A sub-page rectangle assigned to exactly ONE engine. Printed → Paddle, handwritten → TrOCR."""

    x0: float
    y0: float
    x1: float
    y1: float
    kind: RegionKind
    conf: float = 0.0  # classifier confidence that the region is `kind`


@dataclass
class PageRouting:
    """Audit of how one page was routed — surfaced in the response so the decision is never hidden.
    `engines` is the set of engines that actually ran on this page (must be a SUBSET, never all three
    blindly). `unavailable` lists engines the page NEEDED but that were not installed → page degraded
    (KEEP PIXELS), tokens may be empty, and the page is flagged for review rather than guessed."""

    index: int
    kind: PageKind
    width: float
    height: float
    region_count: int = 0
    printed_regions: int = 0
    handwritten_regions: int = 0
    engines: List[str] = field(default_factory=list)
    unavailable: List[str] = field(default_factory=list)
    token_count: int = 0
    degraded: bool = False           # an engine the page needed was missing → KEEP PIXELS
    note: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "kind": self.kind.value,
            "width": round(self.width, 2),
            "height": round(self.height, 2),
            "regionCount": self.region_count,
            "printedRegions": self.printed_regions,
            "handwrittenRegions": self.handwritten_regions,
            "engines": list(self.engines),
            "unavailable": list(self.unavailable),
            "tokenCount": self.token_count,
            "degraded": self.degraded,
            "note": self.note,
        }


class EngineUnavailable(RuntimeError):
    """Raised by an adapter when its backend (paddleocr / torch+transformers) is not installed.
    The router CATCHES this and degrades the page (KEEP PIXELS + flag) — it never substitutes a
    different engine for the region, because one engine per region is a hard rule."""

    def __init__(self, engine: str, detail: str = ""):
        self.engine = engine
        super().__init__(f"OCR engine '{engine}' unavailable: {detail or 'not installed'}")
