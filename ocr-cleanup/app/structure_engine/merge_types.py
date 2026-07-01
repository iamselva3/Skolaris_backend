"""Shared merge primitives — kept in their own module so the span detectors and the
merge orchestrator can both import them without a cycle.

An Attachment says: "this region of orphan content/options BELONGS to `owner` (an
existing question segment) — do NOT split it off." That is the structural heart of
the merge cases.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, List, Optional, Tuple

from .models import MergeCase, OptionRef, WordBox


@dataclass
class Attachment:
    owner: Any                       # the Segment that owns this orphan content
    case: MergeCase
    options: List[OptionRef] = field(default_factory=list)
    region: Optional[Tuple[int, float, float, float, float]] = None  # (page,x0,y0,x1,y1)
    words: List[WordBox] = field(default_factory=list)
    confidence: float = 0.7
    reason: str = ""
