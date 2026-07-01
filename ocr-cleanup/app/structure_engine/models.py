"""Data model for the Structural Intelligence Engine.

INPUT (from TS, the OCR engine already produced this — Python runs NO OCR):
  DocumentInput
    pages: PageInput
      words:   WordBox  (text + bbox + confidence)   ← analysisWordsByPage
      markers: Marker   (TS-detected question-number candidates, with value+punct)

OUTPUT (the PROPOSAL — TS validates it, then persists):
  DocumentAnalysis
    page_classes:  PageClass    (QUESTION / ANSWER_KEY / CORRECTION / APPENDIX / IGNORE)
    questions:     QuestionCandidate (ownership group: number, span, options, merges)
    orphans:       Element      (elements with no confident owner → review)
    sequence:      SequenceReport (duplicates / question-zero / impossible sequences)
    confidence:    float        (whole-document)
    recommendation:str          ('ACCEPT' | 'REVIEW') — advisory; TS decides

Everything is plain dataclasses with from_dict / to_dict so the FastAPI layer can
(de)serialize JSON without any framework coupling inside the engine.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


# ─────────────────────────────────────────────────────────────────────────────
# Enums (universal structural vocabulary — never institute/PDF specific)
# ─────────────────────────────────────────────────────────────────────────────
class PageKind(str, Enum):
    QUESTION = "QUESTION"
    ANSWER_KEY = "ANSWER_KEY"
    CORRECTION = "CORRECTION"
    APPENDIX = "APPENDIX"
    IGNORE = "IGNORE"


class ElementKind(str, Enum):
    QUESTION_NUMBER = "QUESTION_NUMBER"
    QUESTION_TEXT = "QUESTION_TEXT"
    OPTION = "OPTION"
    DIAGRAM = "DIAGRAM"
    GRAPH = "GRAPH"
    TABLE = "TABLE"
    EQUATION = "EQUATION"
    CHEM_STRUCTURE = "CHEM_STRUCTURE"
    LABEL = "LABEL"
    CAPTION = "CAPTION"
    UNKNOWN = "UNKNOWN"


class MergeCase(str, Enum):
    # The 10 cases the user enumerated. Each is a structural relationship that means
    # "do NOT split — these belong to ONE question."
    CROSS_COLUMN_OPTIONS = "CROSS_COLUMN_OPTIONS"          # case 1 / 4
    CROSS_PAGE_CONTINUATION = "CROSS_PAGE_CONTINUATION"    # case 2 / 8
    CROSS_PAGE_OPTIONS = "CROSS_PAGE_OPTIONS"              # case 3
    DIAGRAM_BETWEEN = "DIAGRAM_BETWEEN"                    # case 5 / 10
    WHITESPACE_GAP = "WHITESPACE_GAP"                      # case 6
    MULTI_BLOCK = "MULTI_BLOCK"                            # case 7
    MULTI_COLUMN = "MULTI_COLUMN"                          # case 9


# ─────────────────────────────────────────────────────────────────────────────
# Input
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class WordBox:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    conf: float = 0.0
    # visual_only: word sits INSIDE a detected figure / diagram / formula. KEEP PIXELS (the word renders
    # in the crop) but NEVER promote to structural role — not a marker, not an option label, not a column
    # boundary. Set by the pipeline after figure detection (step 2d.1); False on all deserialized words.
    protected: bool = False

    @property
    def w(self) -> float:
        return self.x1 - self.x0

    @property
    def h(self) -> float:
        return self.y1 - self.y0

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2.0

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2.0

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "WordBox":
        return WordBox(
            text=str(d.get("text", "")),
            x0=float(d.get("x0", 0)),
            y0=float(d.get("y0", 0)),
            x1=float(d.get("x1", 0)),
            y1=float(d.get("y1", 0)),
            conf=float(d.get("conf", d.get("confidence", 0)) or 0),
        )


@dataclass
class Marker:
    """A TS-detected line-start token that looks like a question number. `num` is the
    parsed value (NaN-safe: None when TS saw a question WORD with no digits); `punct`
    is the family ('.', ')', 'Q', 'glued', 'word')."""
    num: Optional[int]
    x0: float
    y0: float
    x1: float
    y1: float
    punct: str = "."

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2.0

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "Marker":
        raw = d.get("num", d.get("number"))
        num: Optional[int]
        try:
            num = int(raw) if raw is not None else None
        except (TypeError, ValueError):
            num = None
        return Marker(
            num=num,
            x0=float(d.get("x0", 0)),
            y0=float(d.get("y0", 0)),
            x1=float(d.get("x1", d.get("x0", 0))),
            y1=float(d.get("y1", d.get("y0", 0))),
            punct=str(d.get("punct", ".")),
        )


@dataclass
class PageInput:
    index: int                       # 1-based page number
    width: float
    height: float
    words: List[WordBox] = field(default_factory=list)
    markers: List[Marker] = field(default_factory=list)
    # ADDITIONAL question-start markers the OCR could not read — CV-detected seal/badge numbers from the
    # Question Boundary Detector. ADDED to (never replace) the token markers, so a badged question is
    # counted and the segmenter gets its boundary. Numberless (the reconciler assigns the value).
    extra_markers: List[Marker] = field(default_factory=list)
    page_image_key: Optional[str] = None   # raw render storage key (CV in Phase 2)
    image_base64: Optional[str] = None      # the page render bytes (base64) — enables CV badge detection in analyze mode

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "PageInput":
        return PageInput(
            index=int(d.get("index", d.get("page", 1))),
            width=float(d.get("width", 0)),
            height=float(d.get("height", 0)),
            words=[WordBox.from_dict(w) for w in (d.get("words") or [])],
            markers=[Marker.from_dict(m) for m in (d.get("markers") or [])],
            extra_markers=[Marker.from_dict(m) for m in (d.get("extraMarkers") or d.get("extra_markers") or [])],
            page_image_key=d.get("pageImageKey") or d.get("page_image_key"),
            image_base64=d.get("imageBase64") or d.get("image_base64"),
        )


@dataclass
class DocumentInput:
    document_id: str
    pages: List[PageInput] = field(default_factory=list)

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "DocumentInput":
        return DocumentInput(
            document_id=str(d.get("documentId", d.get("document_id", ""))),
            pages=[PageInput.from_dict(p) for p in (d.get("pages") or [])],
        )


# ─────────────────────────────────────────────────────────────────────────────
# Output (proposal)
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class Element:
    kind: ElementKind
    page: int
    x0: float
    y0: float
    x1: float
    y1: float
    text: Optional[str] = None
    owner_id: Optional[str] = None       # which QuestionCandidate.id owns it (None = orphan)
    confidence: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "kind": self.kind.value,
            "page": self.page,
            "x0": round(self.x0, 2),
            "y0": round(self.y0, 2),
            "x1": round(self.x1, 2),
            "y1": round(self.y1, 2),
            "text": self.text,
            "ownerId": self.owner_id,
            "confidence": round(self.confidence, 4),
        }


@dataclass
class OptionRef:
    label: Optional[str]
    page: int
    x0: float
    y0: float
    x1: float
    y1: float

    def to_dict(self) -> Dict[str, Any]:
        return {
            "label": self.label,
            "page": self.page,
            "x0": round(self.x0, 2),
            "y0": round(self.y0, 2),
            "x1": round(self.x1, 2),
            "y1": round(self.y1, 2),
        }


@dataclass
class QuestionCandidate:
    id: str
    number: Optional[int]
    number_confidence: float
    start_page: int
    end_page: int
    # union bbox PER page the question touches (a question can span pages/columns)
    boxes: List[Element] = field(default_factory=list)
    options: List[OptionRef] = field(default_factory=list)
    # The question NUMBER's own glyph box [page, x0, y0, x1, y1] — a first-class, locked anchor
    # so the crop layer can GUARANTEE the number is inside every delivered crop and VALIDATE it
    # is visible (never trimmed/cut). None only when no number marker geometry exists (recovered
    # / numberless question — already flagged for review).
    number_box: Optional[List[float]] = None
    merges: List[MergeCase] = field(default_factory=list)
    multi_column: bool = False
    multi_page: bool = False
    multi_block: bool = False
    has_diagram: bool = False
    # Visual element ownership: {diagram,graph,table,equation,chemical_structure} → PASS/FAIL/N/A.
    visuals: Dict[str, str] = field(default_factory=dict)
    complete: bool = False
    confidence: float = 0.0
    # Confidence TIER (constraint #4): AUTO_ACCEPT (>=95) / VERIFY (80–94) / REVIEW (<80).
    tier: str = "REVIEW"
    confidence_pct: int = 0
    needs_review: bool = False
    review_reasons: List[str] = field(default_factory=list)
    # EXPLICIT CROP INSTRUCTIONS — Python OWNS the crop boundary; TS only executes these verbatim.
    # One region per page the question touches: the union of owned boxes + options + number + visuals,
    # clipped to the page's chrome band, padded engine-side, in the SAME pixel space as the words TS
    # sent. TS crops each region and stitches multi-page parts; TS performs NO boundary math.
    crop_regions: List[Dict[str, Any]] = field(default_factory=list)  # [{page,x0,y0,x1,y1,ownerId}]
    visual_regions: List[Dict[str, Any]] = field(default_factory=list)  # [{kind,page,x0,y0,x1,y1}]
    crop_valid: bool = False              # boundary inside page + number contained + not chrome-truncated
    neighbor_leak: bool = False           # another question's marker was found inside this crop (auto-repaired)
    recovered: bool = False               # injected by evidence-based gap recovery (its number was OCR-unread);
    #                                       kept ONLY when ownership/crop validates it (a real, croppable question)
    # Ownership validation (set by ownership_validator before plan_crops; TS reads these).
    crop_allowed: bool = True             # False → ownership validator blocked crop construction; no crop built
    ownership_report: Dict[str, Any] = field(default_factory=dict)  # 7-dimension PASS/FAIL per question
    # True if this question is the first to START on its start_page (by y0 among all questions
    # whose start_page == this start_page). Set after build_questions in the pipeline.
    # Key for cross-page validation: a first-on-page question with multi_page=True may be a
    # false cross-page attribution (Q16 pattern). The cross_page_detector's Validator 2 prevents
    # the absorption; this flag exposes the classification in the validation report.
    first_on_page: bool = False
    question_type: str = "VISUAL"         # SINGLE_CHOICE / MULTI / NUMERIC / ASSERTION_REASON / VISUAL
    # PRE-DELIVERY GATE (the single authority before TS finalizes a crop). Set by
    # pre_delivery_validator AFTER plan_crops + active option search. A crop is deliverable
    # ONLY when the question is complete (number+stem+full option set OR visual stand-in),
    # ownership-valid, crop-valid, and leak-free. TS reads this; Python never renders.
    deliverable: bool = True
    delivery_report: Dict[str, Any] = field(default_factory=dict)

    @property
    def option_count(self) -> int:
        return len(self.options)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "number": self.number,
            "numberConfidence": round(self.number_confidence, 4),
            "startPage": self.start_page,
            "endPage": self.end_page,
            "boxes": [b.to_dict() for b in self.boxes],
            "options": [o.to_dict() for o in self.options],
            "numberBox": list(self.number_box) if self.number_box else None,
            "optionCount": self.option_count,
            "merges": [m.value for m in self.merges],
            "multiColumn": self.multi_column,
            "multiPage": self.multi_page,
            "multiBlock": self.multi_block,
            "hasDiagram": self.has_diagram,
            "visuals": dict(self.visuals),
            "complete": self.complete,
            "confidence": round(self.confidence, 4),
            "confidencePct": self.confidence_pct,
            "tier": self.tier,
            "needsReview": self.needs_review,
            "reviewReasons": list(self.review_reasons),
            "cropRegions": list(self.crop_regions),
            "visualRegions": list(self.visual_regions),
            "cropValid": self.crop_valid,
            "neighborLeak": self.neighbor_leak,
            "cropAllowed": self.crop_allowed,
            "ownershipReport": dict(self.ownership_report),
            "firstOnPage": self.first_on_page,
            "questionType": self.question_type,
            "deliverable": self.deliverable,
            "deliveryReport": dict(self.delivery_report),
        }


@dataclass
class PageClass:
    index: int
    kind: PageKind
    confidence: float
    reason: str = ""
    # A SEMANTIC page role (answer-key / correction / appendix) is a CANDIDATE only —
    # Python proposes it, TS decides. `candidate` is True for semantic kinds; its
    # confidence is hard-capped below the auto-accept floor so TS must always validate.
    candidate: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "index": self.index,
            "kind": self.kind.value,
            "confidence": round(self.confidence, 4),
            "confidencePct": int(round(self.confidence * 100)),
            "candidate": self.candidate,
            "reason": self.reason,
        }


@dataclass
class SequenceReport:
    expected_range: Optional[List[int]] = None    # [min, max] of confident question numbers
    duplicates: List[int] = field(default_factory=list)
    question_zero: bool = False
    impossible: List[Dict[str, Any]] = field(default_factory=list)  # {prev, next, reason}
    gaps: List[int] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "expectedRange": self.expected_range,
            "duplicates": self.duplicates,
            "questionZero": self.question_zero,
            "impossible": self.impossible,
            "gaps": self.gaps,
        }


@dataclass
class DocumentAnalysis:
    document_id: str
    schema_version: int
    page_classes: List[PageClass] = field(default_factory=list)
    questions: List[QuestionCandidate] = field(default_factory=list)
    orphans: List[Element] = field(default_factory=list)
    sequence: SequenceReport = field(default_factory=SequenceReport)
    confidence: float = 0.0
    recommendation: str = "REVIEW"
    integrity: Dict[str, Any] = field(default_factory=dict)
    # Question Count Authority output: {logicalQuestionCount, confidence, anomalies, reconciled}.
    question_count: Dict[str, Any] = field(default_factory=dict)
    # Ownership completeness gate (mandatory before crop build): per-question heatmap + cropGate.
    ownership_heatmap: List[Dict[str, Any]] = field(default_factory=list)
    crop_gate: str = "REVIEW"
    # Pre-delivery gate (single authority): "PASS" only when EVERY question is deliverable.
    delivery_gate: str = "REVIEW"
    # Per-responsibility promotion (Python PRIMARY vs advisory) — the frozen authority split.
    promotion: Dict[str, str] = field(default_factory=dict)
    notes: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "documentId": self.document_id,
            "schemaVersion": self.schema_version,
            "pageClasses": [p.to_dict() for p in self.page_classes],
            "questions": [q.to_dict() for q in self.questions],
            "orphans": [o.to_dict() for o in self.orphans],
            "sequence": self.sequence.to_dict(),
            "confidence": round(self.confidence, 4),
            "recommendation": self.recommendation,
            "integrity": dict(self.integrity),
            "questionCount": dict(self.question_count),
            "ownershipHeatmap": list(self.ownership_heatmap),
            "cropGate": self.crop_gate,
            "deliveryGate": self.delivery_gate,
            "promotion": dict(self.promotion),
            "notes": list(self.notes),
        }


SCHEMA_VERSION = 1
