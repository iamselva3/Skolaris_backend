"""Faithful port of the Node sequential-context draft parser
(src/shared/ocr-engine/routing.ts / ocr-engine.ts parseDrafts + inferType).

Keeping the SAME heuristic means a handwritten paper and a printed paper turn
into the same draft shape, so the review UI is source-agnostic.
"""
import re
from dataclasses import dataclass
from typing import List, Optional

MAX_DRAFTS_DEFAULT = 20

QUESTION_WORDS = re.compile(
    r"^\s*(which|what|how|why|when|where|who|explain|describe|name|state|find|calculate|determine|identify|select|choose|consider)\b",
    re.IGNORECASE,
)
NUMBERED_LINE = re.compile(r"^(\d{1,2})\s*([.):])\s*(.*)$")
Q_PREFIX = re.compile(r"^Q\s*\.?\s*(\d{1,2})\s*[.:)]\s*(.*)$", re.IGNORECASE)
LETTERED_OPTION = re.compile(r"^\(?([a-d])\)?\s*[.):]\s*(.+)$", re.IGNORECASE)


@dataclass
class DraftOption:
    label: str
    isCorrect: bool = False


@dataclass
class Draft:
    position: int
    text: str
    detectedType: Optional[str] = None
    options: Optional[List[DraftOption]] = None
    confidence: Optional[float] = None


def infer_type(stem: str, option_count: int) -> str:
    s = stem.lower()
    if re.search(r"\b(true or false|\(t/f\)|t or f)\b", s):
        return "TRUE_FALSE"
    if re.search(r"\b(select all|all that apply|multiple correct)\b", s):
        return "MULTIPLE_CHOICE"
    if re.search(r"_{4,}|\bfill in the blank", s):
        return "FILL_BLANK"
    if option_count >= 2:
        return "SINGLE_CHOICE"
    return "DESCRIPTIVE"


def parse_drafts(raw_text: str, overall_confidence: float, max_drafts: int = MAX_DRAFTS_DEFAULT) -> List[Draft]:
    text = (
        raw_text.replace("\r\n", "\n")
        .replace("“", '"').replace("”", '"')
        .replace("‘", "'").replace("’", "'")
    )
    lines = [ln.strip() for ln in text.split("\n")]
    lines = [ln for ln in lines if ln]

    questions: List[dict] = []
    current: Optional[dict] = None

    def open_question(stem_seed: str) -> None:
        nonlocal current
        if current is not None:
            questions.append(current)
        current = {"stem": [stem_seed] if stem_seed else [], "options": []}

    def push_option(body: str) -> None:
        nonlocal current
        if current is None:
            current = {"stem": [], "options": [body]}
            return
        current["options"].append(body)

    for line in lines:
        qp = Q_PREFIX.match(line)
        if qp:
            open_question(qp.group(2))
            continue

        nm = NUMBERED_LINE.match(line)
        if nm:
            num = int(nm.group(1))
            marker = nm.group(2)
            body = nm.group(3)
            if marker == ")":
                open_question(body)
                continue
            if current is not None:
                expected = len(current["options"]) + 1
                if num == expected and len(current["options"]) < 6:
                    push_option(body)
                    continue
            looks_like_stem = len(body) > 25 or body.rstrip().endswith("?") or bool(QUESTION_WORDS.match(body))
            if looks_like_stem:
                open_question(body)
            else:
                push_option(body)
            continue

        lp = LETTERED_OPTION.match(line)
        if lp:
            push_option(lp.group(2))
            continue

        if current is None:
            continue
        if current["options"]:
            current["options"][-1] += " " + line
        else:
            current["stem"].append(line)

    if current is not None:
        questions.append(current)

    drafts: List[Draft] = []
    for i, q in enumerate(questions[:max_drafts]):
        stem = re.sub(r"\s+", " ", " ".join(q["stem"])).strip()
        opts = [DraftOption(label=re.sub(r"\s+", " ", o).strip(), isCorrect=False) for o in q["options"]]
        opts = [o for o in opts if o.label]
        drafts.append(
            Draft(
                position=i,
                text=stem,
                detectedType=infer_type(stem, len(opts)),
                options=opts if len(opts) >= 2 else None,
                confidence=overall_confidence,
            )
        )
    return drafts
