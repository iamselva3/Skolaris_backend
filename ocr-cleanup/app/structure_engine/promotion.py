"""Authority registry — the ONE-engine boundary.

There is a SINGLE document-intelligence engine: Python. This registry declares the
authority split between that engine and the TS platform. `PROMOTED` = the responsibility
lives INSIDE the Python intelligence engine (Python is the source of truth); the document
structure work is no longer re-derived by TS. `NOT_PROMOTED` = a TS platform / business
responsibility (OCR extraction, business rules, answer-key / MCQ / numbering validation,
persistence, review routing) — for the semantic ones Python may only SUGGEST a candidate;
TS decides. Persistence is permanently NOT_PROMOTED: Python proposes, TS persists, always —
Python never touches the database.

Emitted in the proposal so the boundary is explicit, testable, and mirrored on the TS side.
"""
from __future__ import annotations

from typing import Dict

PROMOTED = "PROMOTED"          # inside the Python intelligence engine (source of truth)
NOT_PROMOTED = "NOT_PROMOTED"  # TS platform / business (semantic ones: Python suggests, TS decides)

# Document-structure intelligence = PROMOTED (the Python engine). Platform / business /
# persistence = NOT_PROMOTED (TS). This is the final single-engine split, not a ramp.
REGISTRY: Dict[str, str] = {
    # ── cleanup → Python engine ───────────────────────────────────────────────────────
    "background_removal": PROMOTED,
    "watermark_removal": PROMOTED,
    "header_detection": PROMOTED,
    "footer_detection": PROMOTED,
    "divider_detection": PROMOTED,
    "shadow_removal": PROMOTED,
    "noise_removal": PROMOTED,
    # ── question + ownership intelligence → Python engine ─────────────────────────────
    "question_count": PROMOTED,
    "ownership_graph": PROMOTED,
    "merge_detection": PROMOTED,
    "continuation_detection": PROMOTED,
    "cross_column_ownership": PROMOTED,
    "cross_page_ownership": PROMOTED,
    "whitespace_ownership": PROMOTED,
    "orphan_detection": PROMOTED,
    "broken_option_detection": PROMOTED,
    "duplicate_detection": PROMOTED,
    "question_zero_detection": PROMOTED,
    "impossible_sequence_detection": PROMOTED,
    "confidence_scoring": PROMOTED,
    # ── question reconstruction (Python BUILDS the crop) → Python engine ──────────────
    "crop_construction": PROMOTED,
    "crop_alignment": PROMOTED,
    "crop_repair": PROMOTED,
    "crop_validation": PROMOTED,
    "incomplete_crop_detection": PROMOTED,
    "option_attachment": PROMOTED,
    "continuation_attachment": PROMOTED,
    "diagram_attachment": PROMOTED,
    "whitespace_reduction": PROMOTED,
    # element ownership (Phase-2 CV detectors back these) → Python engine
    "diagram_ownership": PROMOTED,
    "graph_ownership": PROMOTED,
    "table_ownership": PROMOTED,
    "equation_ownership": PROMOTED,
    "chemical_structure_ownership": PROMOTED,
    # ── validation → Python engine ────────────────────────────────────────────────────
    "mcq_completeness": PROMOTED,
    "complete_question_validation": PROMOTED,
    "nnc_validation": PROMOTED,
    # ── TS infrastructure / business → NOT structure (TS decides, Python never) ───────
    "answer_key_logic": NOT_PROMOTED,
    "business_rules": NOT_PROMOTED,
    # persistence → NEVER promoted: Python proposes, TS persists, always.
    "persistence": NOT_PROMOTED,
}


def is_promoted(responsibility: str) -> bool:
    return REGISTRY.get(responsibility) == PROMOTED


def registry() -> Dict[str, str]:
    return dict(REGISTRY)
