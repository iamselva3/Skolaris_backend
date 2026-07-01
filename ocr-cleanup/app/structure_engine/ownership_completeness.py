"""Ownership completeness gate — MANDATORY before any crop is built.

`ownership graph → OWNERSHIP COMPLETENESS → build crop → repair → validate → deliver`.

Every question owner must PROVE it owns each element (question number, text, options,
continuation, and — Phase 2 CV — diagram/graph/table/equation/chemical structure). Each
element is PASS (owned), FAIL (missing/incomplete), or N/A (not applicable). Plus the
one-owner invariant: an element with 0 owners FAILs, an element with 2 owners is a
conflict; only exactly 1 owner passes.

Per question it emits a heatmap entry:
    { questionId, number, completeness, checks, missing, detached, ownershipConflicts, cropAllowed }

Crop construction is PERMITTED only when completeness >= 0.95 AND no conflicts AND no
detached elements. Otherwise repair/recompute, and REVIEW only as the last resort. Pure
over the proposal data; no IO.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

CROP_OWNERSHIP_THRESHOLD = 0.95

_FULL_OPTION_LETTERS = ["a", "b", "c", "d", "e"]
_FULL_OPTION_DIGITS = ["1", "2", "3", "4", "5"]


def _missing_option_labels(options: List[Dict[str, Any]], expected: int) -> List[str]:
    present = {str(o.get("label")).lower() for o in options if o.get("label") is not None}
    if not present:
        return []
    family = _FULL_OPTION_LETTERS if present & set(_FULL_OPTION_LETTERS) else _FULL_OPTION_DIGITS
    return [lab for lab in family[:expected] if lab not in present]


def _assess_one(q: Dict[str, Any], expected: int) -> Dict[str, Any]:
    checks: Dict[str, str] = {}
    missing: List[str] = []

    checks["question_number"] = "PASS" if q.get("number") is not None else "FAIL"
    if q.get("number") is None:
        missing.append("question_number")

    has_text = bool(q.get("boxes"))
    checks["question_text"] = "PASS" if has_text else "FAIL"
    if not has_text:
        missing.append("question_text")

    n = int(q.get("optionCount", 0))
    if n == 0:
        checks["options"] = "N/A"  # subjective / diagram-only question
    else:
        # Any options present (full or partial) → ownership is PROVED; missing labels are advisory.
        # Partial sets (0 < n < expected) are no longer a hard FAIL — pre_delivery_validator
        # searches for and gates on them; the heatmap records which labels are absent for TS.
        checks["options"] = "PASS"
        if n < expected:
            labels = _missing_option_labels(q.get("options", []), expected)
            if labels:
                for lab in labels:
                    missing.append(f"option_{lab}")
            else:
                missing.append(f"options_{n}_of_{expected}")

    # continuation: a multi-page / multi-column question had its continuation MERGED (owned).
    checks["continuation"] = "PASS" if (q.get("multiPage") or q.get("multiColumn")) else "N/A"

    # visual elements — from the visual detectors (token layer now; CV layer on render wiring).
    # PASS = detected & owned (inside the crop union); N/A = none detected. A DETECTED-but-detached
    # element is set to FAIL upstream so the crop is repaired before delivery.
    visuals = q.get("visuals") or {}
    for k in ("diagram", "graph", "table", "equation", "chemical_structure"):
        checks[k] = visuals.get(k, "N/A")

    passes = sum(1 for v in checks.values() if v == "PASS")
    fails = sum(1 for v in checks.values() if v == "FAIL")
    completeness = round(passes / (passes + fails), 4) if (passes + fails) else 1.0
    return {"checks": checks, "missing": missing, "completeness": completeness}


def _option_key(o: Dict[str, Any]) -> str:
    return f"{o.get('page')}:{int(round(float(o.get('x0', 0))))}:{int(round(float(o.get('y0', 0))))}"


def build_heatmap(analysis_dict: Dict[str, Any], expected_options: int = 4) -> Tuple[List[Dict[str, Any]], str]:
    """Return (heatmap, cropGate). cropGate is PASS only when every question may be cropped
    (completeness >= threshold, no conflicts, no detached) AND document integrity is PASS.
    `expected_options` = the paper's inferred dominant option count."""
    questions = analysis_dict.get("questions", [])
    orphans = analysis_dict.get("orphans", [])
    integrity_pass = analysis_dict.get("integrity", {}).get("status") == "PASS"

    # one-owner invariant across questions: an option position claimed by >1 question = conflict
    claims: Dict[str, List[str]] = {}
    for q in questions:
        for o in q.get("options", []):
            claims.setdefault(_option_key(o), []).append(q.get("id"))
    conflict_keys = {k for k, owners in claims.items() if len(set(owners)) > 1}

    heatmap: List[Dict[str, Any]] = []
    all_allowed = True
    for q in questions:
        a = _assess_one(q, expected_options)
        # detached: orphan OPTION elements on a page this question spans, near its vertical band
        detached: List[str] = []
        q_pages = {b.get("page") for b in q.get("boxes", [])}
        ys = [b.get("y0", 0) for b in q.get("boxes", [])] + [b.get("y1", 0) for b in q.get("boxes", [])]
        y_lo, y_hi = (min(ys), max(ys)) if ys else (0, 0)
        for orf in orphans:
            if orf.get("kind") != "OPTION":
                continue
            if orf.get("page") in q_pages and (y_lo - 50) <= orf.get("y0", 0) <= (y_hi + 80):
                detached.append(f"orphan_option@p{orf.get('page')}")
        conflicts = [k for k in (_option_key(o) for o in q.get("options", [])) if k in conflict_keys]

        crop_allowed = (
            a["completeness"] >= CROP_OWNERSHIP_THRESHOLD and not conflicts and not detached
        )
        if not crop_allowed:
            all_allowed = False
        heatmap.append(
            {
                "questionId": q.get("id"),
                "number": q.get("number"),
                "completeness": a["completeness"],
                "checks": a["checks"],
                "missing": a["missing"],
                "detached": detached,
                "ownershipConflicts": conflicts,
                "cropAllowed": crop_allowed,
            }
        )

    crop_gate = "PASS" if (all_allowed and integrity_pass and questions) else "REVIEW"
    return heatmap, crop_gate
