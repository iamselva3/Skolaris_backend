"""SKOLARIS Structural Intelligence Engine.

Python understands DOCUMENT STRUCTURE — it is NOT OCR, NOT AI, NOT business logic.
It CONSUMES the OCR tokens + page renders that the (frozen) TS OCR engine already
produced, reasons about structure (question ownership, merges, sequence, page
class), and PROPOSES a structural analysis. TS validates the proposal and persists.
Python never persists, never crops, never splits, never guesses silently — uncertain
ownership routes to review.

Every module here is a pure-function unit with NO IO, independently testable. All
thresholds derive from the document's own geometry (median glyph height + whitespace
projections); there are no hardcoded coordinates / institute names / env tunables.
"""
from .pipeline import analyze_document  # noqa: F401

__all__ = ["analyze_document"]
