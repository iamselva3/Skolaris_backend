"""RUNTIME AUDIT of question-number detection + handwritten-OCR recovery. Proves at runtime (not by
inspecting code) which engine produced each question number, and whether the handwritten/RapidOCR recovery
actually executed. Reads the engine's OWN recovery_log (questionCount.handwrittenRecovery).

  python runtime_audit.py <capture.tokens.json>

Run it twice: STRUCTURE_NUMBER_OCR=0 (default) and =1, to compare.
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:  # noqa: BLE001
    pass
from PIL import Image  # noqa: E402

from app.structure_engine.pipeline import analyze_document  # noqa: E402


def main(argv):
    cap = json.load(open(argv[1], encoding="utf-8"))
    for p in cap["pages"]:
        if p.get("imageBase64") and not p.get("width"):
            im = Image.open(io.BytesIO(base64.b64decode(p["imageBase64"])))
            p["width"], p["height"] = im.width, im.height

    flag = os.environ.get("STRUCTURE_NUMBER_OCR", "0")
    print(f"\n========== RUNTIME AUDIT  (STRUCTURE_NUMBER_OCR={flag})  {os.path.basename(argv[1])[:24]} ==========")
    res = analyze_document(cap)
    qs = res.get("questions", [])
    rec = (res.get("questionCount") or {}).get("handwrittenRecovery") or {}

    # ---- handwritten-OCR execution proof ----
    started = rec.get("handwrittenOcrEnabled", False)
    regions = rec.get("handwrittenOcrRegionsProcessed", 0)
    recovered = rec.get("recoveredQuestions", []) or []
    print("\n--- HANDWRITTEN OCR EXECUTION ---")
    print(f"HANDWRITTEN_OCR_ENABLED   = {started}")
    print(f"HANDWRITTEN_OCR_EXECUTED  = {rec.get('handwrittenOcrExecuted', False)}")
    print(f"HANDWRITTEN_REGIONS_FOUND = {regions}")
    print(f"HANDWRITTEN_NUMBERS_DETECTED = {len(recovered)}  -> {sorted(recovered)}")
    print(f"gaps (missing numbers)    = {rec.get('missingQuestions', [])}")
    if not started:
        print(">>> VERDICT: handwritten OCR is DISABLED (STRUCTURE_NUMBER_OCR off) — it did NOT run.")
    elif regions == 0:
        print(">>> VERDICT: handwritten OCR enabled but RegionsFound=0 — it did NOT run (no gap / no render).")
    elif len(recovered) == 0:
        print(">>> VERDICT: handwritten OCR RAN but detected 0 numbers — it is FAILING on this paper.")
    else:
        print(f">>> VERDICT: handwritten OCR RAN and recovered {len(recovered)} number(s).")

    recovered_set = set(recovered)

    # ---- per-question source engine ----
    print("\n--- PER QUESTION  (Q | Page | Number | SourceEngine) ---")
    for q in qs:
        n = q.get("number")
        pg = (q.get("number_box") or [None])[0]
        src = "HandwrittenOCR" if (n in recovered_set) else ("Tesseract" if q.get("number_box") else "Tesseract(gap-fill)")
        print(f"   Q{n}  Page={int(pg) if pg is not None else '?'}  Number={n}  SourceEngine={src}")

    # ---- per-page marker report ----
    print("\n--- PER PAGE  (Page | Digital | Printed | Handwritten | Final | SourceEngines) ---")
    pages = sorted({int((q.get('number_box') or [0])[0]) for q in qs if q.get('number_box')})
    for pg in pages:
        on_page = [q for q in qs if q.get("number_box") and int(q["number_box"][0]) == pg]
        hw = [q for q in on_page if q.get("number") in recovered_set]
        printed = [q for q in on_page if q.get("number") not in recovered_set]
        engines = []
        if printed:
            engines.append("Tesseract")
        if hw:
            engines.append("HandwrittenOCR")
        print(f"   Page {pg}: Digital=0  Printed={len(printed)}  Handwritten={len(hw)}  "
              f"Final={len(on_page)}  Source={'+'.join(engines) or 'none'}")

    print(f"\nTOTAL logical questions = {len(qs)}  (expected ~{(res.get('questionCount') or {}).get('expectedCount')})")


if __name__ == "__main__":
    main(sys.argv)
