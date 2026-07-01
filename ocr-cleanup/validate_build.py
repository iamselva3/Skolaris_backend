"""End-to-end build validation report — the APPROVED path only.

Runs the FULL Python build (`build_document`) on CAPTURED TS-OCR token+render payloads
(`<doc>.tokens.json` written by the delivery seam when `STRUCTURE_CAPTURE_DIR` is set, now
including `imageBase64` page renders). This is the SAME `TS OCR → Python` path used in
production — scanned / digital / mixed, no offline PyMuPDF shortcut, no source-type split.

Per the spec, prints for every PDF: Expected / Logical / Ownership / Complete / Crop /
Delivered counts, Duplicates, Question 0, Impossible Sequences, cross-page / cross-column
issues, diagram / graph / table / equation / chemical issues, N=N=C, and PASS/FAIL.

Usage:
  1. STRUCTURE_CAPTURE_DIR=<dir> on the API; upload the regression PDFs (real TS OCR).
  2. (optional) expected.json: {"PHYCHE": 50, "AIOTS 1 & DR09 Q @ sk_0476": 180, ...}
  3. .venv/Scripts/python.exe validate_build.py <dir> [expected.json]
"""
from __future__ import annotations

import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.structure_engine.document_builder import build_document  # noqa: E402

_VISUALS = ("diagram", "graph", "table", "equation", "chemical_structure")


def _visual_issues(questions, kind):
    return sum(1 for q in questions if (q.get("visuals") or {}).get(kind) == "FAIL")


def report(payload, expected_map):
    name = payload.get("documentId", "?")
    res = build_document(payload)
    qs = res.get("questions", [])
    qc = res.get("questionCount", {})
    seq = res.get("sequence", {})
    nnc = res.get("integrity", {}).get("nnc", {})
    s1 = nnc.get("stage1", {})
    s2 = res.get("build", {}).get("stage2", {})
    logical = qc.get("logicalQuestionCount", 0)
    crop_count = res.get("build", {}).get("cropCount", 0)
    delivered = res.get("build", {}).get("deliveredQuestionCount", 0)
    nnc_pass = bool(s1.get("pass")) and (s2.get("status") == "PASS")
    expected = expected_map.get(name, "—")

    print("=" * 60)
    print(f"PDF Name:               {name}")
    print(f"Expected Questions:     {expected}")
    print(f"Logical Questions:      {logical}")
    print(f"Ownership Count:        {s1.get('ownershipCount', 0)}")
    print(f"Complete Questions:     {s1.get('completeQuestionCount', 0)}")
    print(f"Crop Count:             {crop_count}")
    print(f"Delivered Count:        {delivered}")
    print(f"Missing Questions:      {qc.get('missingQuestions', [])}")
    print(f"Recovered Questions:    {qc.get('recoveredQuestions', [])}")
    print(f"Duplicates:             {len(seq.get('duplicates', []))}")
    print(f"Question 0:             {1 if seq.get('questionZero') else 0}")
    print(f"Impossible Sequences:   {len(seq.get('impossible', []))}")
    print(f"Cross-page Issues:      {sum(1 for q in qs if q.get('multiPage') and q.get('needsReview'))}")
    print(f"Cross-column Issues:    {sum(1 for q in qs if q.get('multiColumn') and q.get('needsReview'))}")
    print(f"Diagram Issues:         {_visual_issues(qs, 'diagram')}")
    print(f"Graph Issues:           {_visual_issues(qs, 'graph')}")
    print(f"Table Issues:           {_visual_issues(qs, 'table')}")
    print(f"Equation Issues:        {_visual_issues(qs, 'equation')}")
    print(f"Chemical Struct Issues: {_visual_issues(qs, 'chemical_structure')}")
    print(f"N=N=C:                  {'PASS' if nnc_pass else 'FAIL'} (stage1={s1.get('pass')}, stage2={s2.get('status')})")
    print(f"VERDICT:                {'PASS' if res.get('deliver') else 'FAIL'}")


def main(argv):
    target = argv[1] if len(argv) > 1 else "."
    expected_map = {}
    if len(argv) > 2 and os.path.exists(argv[2]):
        with open(argv[2], "r", encoding="utf-8") as fh:
            expected_map = json.load(fh)
    files = ([target] if target.endswith(".json")
             else sorted(glob.glob(os.path.join(target, "*.tokens.json"))))
    if not files:
        print(f"No token+render captures (*.tokens.json) in {target!r}.")
        print("Set STRUCTURE_CAPTURE_DIR on the API and upload the regression PDFs first.")
        return 1
    for f in files:
        try:
            with open(f, "r", encoding="utf-8") as fh:
                report(json.load(fh), expected_map)
        except Exception as e:  # noqa: BLE001
            print(f"ERROR {os.path.basename(f)}: {type(e).__name__}: {e}")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
