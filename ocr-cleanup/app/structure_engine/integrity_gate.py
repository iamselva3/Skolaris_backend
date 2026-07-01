"""Integrity gate — the ownership graph is the SOURCE OF TRUTH (constraint #2) and the
N=N=C invariant (constraint #3) is checked here on the slice Python can see.

Ownership invariant: every detected element belongs to EXACTLY ONE owner.
  • one question → two owners  : a question with no owned box (it owns nothing)        → violation
  • two questions → one owner  : a single element claimed by >1 question id            → violation

N=N=C (Python's slice — TS owns the full delivered/persisted/navigator cross-check):
  N  = logicalQuestionCount      = number of question candidates
  No = ownedQuestionCount        = candidates that own ≥1 element (no empty owners)
  C  = completeQuestionCount     = candidates that are complete AND not in review
  R  = reviewCount               = candidates routed to review
  orphanElementCount             = elements with NO owner (unclaimed content)

STATUS = PASS only when: no ownership violations, every question owns something,
no orphans, and C == N (every logical question is complete & accepted). Otherwise STOP
→ TS must route to review and NOT persist. Python only reports; TS enforces the stop.
"""
from __future__ import annotations

from typing import Any, Dict, List

from .models import DocumentAnalysis, QuestionCandidate


def _element_keys(q: QuestionCandidate) -> List[str]:
    """Stable identity for every element a question claims (boxes + option refs)."""
    keys: List[str] = []
    for b in q.boxes:
        keys.append(f"{b.kind.value}:{b.page}:{int(round(b.x0))}:{int(round(b.y0))}")
    for o in q.options:
        keys.append(f"OPTION:{o.page}:{int(round(o.x0))}:{int(round(o.y0))}")
    return keys


def compute_integrity(analysis: DocumentAnalysis) -> Dict[str, Any]:
    questions = analysis.questions
    n_logical = len(questions)
    owned = [q for q in questions if q.boxes]
    n_owned = len(owned)
    complete = [q for q in questions if q.complete and not q.needs_review]
    n_complete = len(complete)
    n_review = sum(1 for q in questions if q.needs_review)
    n_orphans = len(analysis.orphans)

    # two-questions-one-owner: an element key claimed by more than one question
    claim_count: Dict[str, int] = {}
    claim_owner: Dict[str, str] = {}
    double_claimed: List[str] = []
    for q in questions:
        for k in _element_keys(q):
            claim_count[k] = claim_count.get(k, 0) + 1
            if claim_count[k] == 1:
                claim_owner[k] = q.id
            elif claim_count[k] == 2:
                double_claimed.append(k)

    # one-question-two-owners: a question owning nothing (degenerate owner)
    empty_owners = [q.id for q in questions if not q.boxes]

    violations: List[str] = []
    if double_claimed:
        violations.append(f"element_double_claimed:{len(double_claimed)}")
    if empty_owners:
        violations.append(f"empty_owner:{len(empty_owners)}")
    if n_orphans:
        violations.append(f"orphan_elements:{n_orphans}")

    # ── STAGED N=N=C (two-stage proof) ────────────────────────────────────────────────
    # Stage 1 (provable NOW, Python-only): logicalQuestionCount == ownershipCount ==
    #   completeQuestionCount, with no ownership violations. This gates everything pre-delivery.
    # Stage 2 (requires crop-delivery wiring): cropCount == deliveredQuestionCount. Until the
    #   render/crop pipeline is wired it is PENDING_WIRING — NOT a fail, just not yet evaluated.
    stage1_pass = (n_logical == n_owned == n_complete) and not violations
    nnc = {
        "stage1": {
            "logicalQuestionCount": n_logical,
            "ownershipCount": n_owned,
            "completeQuestionCount": n_complete,
            "pass": stage1_pass,
        },
        "stage2": {
            "cropCount": None,
            "deliveredQuestionCount": None,
            "status": "PENDING_WIRING",
        },
        # overall gate at this phase = Stage 1 (delivery legs are not yet wired)
        "status": "PASS" if stage1_pass else "STOP",
    }

    status = "PASS" if stage1_pass else "STOP"
    return {
        "logicalQuestionCount": n_logical,
        "ownedQuestionCount": n_owned,
        "completeQuestionCount": n_complete,
        "reviewCount": n_review,
        "orphanElementCount": n_orphans,
        "ownershipViolations": violations,
        "nEqualsNEqualsC": stage1_pass,  # = Stage 1 (back-compat)
        "nnc": nnc,
        "status": status,
    }
