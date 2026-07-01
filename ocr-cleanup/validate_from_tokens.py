"""Regression validation — the APPROVED path only.

Runs the Python intelligence engine on CAPTURED TS-OCR token payloads (the exact
`{documentId, pages:[{index,width,height,words}]}` the delivery seam sends to
`/analyze-document`). This is the SAME `TS OCR → Python` path used in production, for
EVERY PDF — scanned, digital, mixed. There is NO PyMuPDF/offline shortcut and no
source-type special-casing: the input contract is identical for all documents.

How to produce the token captures (run the real pipeline once):
  1. set `STRUCTURE_CAPTURE_DIR=/some/dir` on the API
  2. upload the regression PDFs (AIOTS / AD / RE NEET / Biology / Biology_Cell / PHYCHE
     + unseen) — TS OCR extracts tokens and the seam writes `<doc>.tokens.json`
  3. run:  .venv/Scripts/python.exe validate_from_tokens.py /some/dir

Each capture is the genuine TS OCR output (scanned pages included), so this validates
Python on ALL document types through the production path.
"""
from __future__ import annotations

import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.structure_engine import analyze_document  # noqa: E402


def report(payload: dict) -> None:
    name = payload.get("documentId", "?")
    res = analyze_document(payload)
    qc = res.get("questionCount", {})
    seq = res.get("sequence", {})
    integ = res.get("integrity", {})
    logical = qc.get("logicalQuestionCount", 0)
    complete = qc.get("completeQuestionCount", 0)
    print("-" * 60)
    print(f"Document: {name}")
    if logical == 0:
        print("  Logical Questions: 0  → Verdict: NO_QUESTIONS (check the token capture)")
        return
    own = "PASS" if integ.get("status") == "PASS" else "FAIL"
    nnc = "PASS" if integ.get("nEqualsNEqualsC") else "FAIL"
    mcq = "PASS" if complete == logical else "FAIL"
    verdict = "PASS" if res.get("recommendation") == "ACCEPT" else "STOP"
    print(f"  Logical Questions: {logical}")
    print(f"  Duplicates: {len(seq.get('duplicates', []))}")
    print(f"  Question 0: {1 if seq.get('questionZero') else 0}")
    print(f"  Impossible Sequence: {len(seq.get('impossible', []))}")
    print(f"  Missing Numbers: {len(seq.get('gaps', []))}")
    print(f"  Spurious markers removed: {qc.get('reconciled', {}).get('spurious', 0) + qc.get('reconciled', {}).get('offMargin', 0)}")
    print(f"  Complete Questions: {complete}")
    print(f"  Ownership Integrity: {own}")
    print(f"  MCQ Completeness: {mcq}")
    print(f"  N=N=C: {nnc}")
    print(f"  Confidence: {qc.get('confidence')}")
    print(f"  Verdict: {verdict}")


def main(argv) -> int:
    target = argv[1] if len(argv) > 1 else "."
    files = (
        [target] if target.endswith(".json")
        else sorted(glob.glob(os.path.join(target, "*.tokens.json")) + glob.glob(os.path.join(target, "*.json")))
    )
    if not files:
        print(f"No token captures (*.tokens.json) found in {target!r}.")
        print("Set STRUCTURE_CAPTURE_DIR on the API and upload the regression PDFs first.")
        return 1
    for f in files:
        try:
            with open(f, "r", encoding="utf-8") as fh:
                report(json.load(fh))
        except Exception as e:  # noqa: BLE001
            print(f"  ERROR {os.path.basename(f)}: {type(e).__name__}: {e}")
    print("-" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
