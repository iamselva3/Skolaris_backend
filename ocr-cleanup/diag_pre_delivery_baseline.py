"""Regression harness: run analyze_document on each baseline capture and print the counts
memory tracks (logical question count, cropValid count) PLUS the new pre-delivery signals
(deliverable count, deliveryGate, active-search recovery). Confirms the validator changes
did not move the baselines."""
from __future__ import annotations

import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:  # noqa: BLE001
    pass

from app.structure_engine.pipeline import analyze_document  # noqa: E402

CAP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "crop-trace-out", "capture")
BASELINES = {
    "2d28720c": "PHYCHE(50/50)",
    "e21a4506": "e21(177/143)",
    "33d46aa4": "AD2601(187/124)",
    "e1ac37b9": "AIOTS(170/114)",
    "cc7f563e": "25REP(116/72)",
}


def _find(prefix: str):
    hits = glob.glob(os.path.join(CAP_DIR, f"*_{prefix}*tokens.json"))
    return hits[0] if hits else None


for prefix, label in BASELINES.items():
    path = _find(prefix)
    if not path:
        print(f"{label:18s} MISSING capture")
        continue
    try:
        cap = json.load(open(path, encoding="utf-8"))
        r = analyze_document(cap)
    except Exception as e:  # noqa: BLE001
        print(f"{label:18s} ERROR {repr(e)[:120]}")
        continue
    qs = r["questions"]
    logical = len(qs)
    crop_valid = sum(1 for q in qs if q.get("cropValid"))
    opt_sum = sum(q.get("optionCount", 0) for q in qs)
    deliverable = sum(1 for q in qs if q.get("deliverable")) if any("deliverable" in q for q in qs) else -1
    recovered = sum(q.get("deliveryReport", {}).get("optionsRecovered", 0) or 0 for q in qs)
    searched = sum(1 for q in qs if q.get("deliveryReport", {}).get("searchedRegions"))
    print(
        f"{label:18s} logical={logical:4d} cropValid={crop_valid:4d} optSum={opt_sum:5d} "
        f"deliverable={deliverable:4d} gate={str(r.get('deliveryGate')):6s} "
        f"reco={str(r.get('recommendation')):7s} | activeSearch:q={searched} optsRecovered={recovered}"
    )
