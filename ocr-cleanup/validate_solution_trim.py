"""Validation table for the ownership-driven solution trim (the user's spec):

  Question | SolutionDetected | SolutionRemoved | OwnershipPASS | CropPASS | NextQuestionSafe | PASS/FAIL

NextQuestionSafe = question N's crop never overlaps question N+1's marker (the golden rule). SolutionRemoved
is inferred by comparing the crop bottom to the owned-content bottom (a cap below owned content = trimmed).

  python validate_solution_trim.py <capture.tokens.json>
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
    res = analyze_document(cap)
    qs = res.get("questions", [])
    exp = res.get("questionCount", {}).get("expectedCount")

    # marker top per question (for next-question-safe), keyed by number
    markers = {}
    for q in qs:
        nb = q.get("number_box")
        if nb:
            markers[q.get("number")] = (int(nb[0]), float(nb[2]))  # (page, y0)

    rows = []
    fails = 0
    for i, q in enumerate(qs):
        num = q.get("number")
        cr = q.get("cropRegions") or []
        oc = q.get("optionCount") or 0
        own_pass = oc >= (exp or 4) or bool(q.get("hasDiagram"))
        crop_pass = bool(q.get("cropValid"))
        # crop bottom on its last page
        last = max(cr, key=lambda r: (r["page"], r["y1"])) if cr else None
        # next question marker
        nxt = qs[i + 1] if i + 1 < len(qs) else None
        safe = True
        if nxt and last:
            nnb = nxt.get("number_box")
            if nnb:
                np_, ny = int(nnb[0]), float(nnb[2])
                if last["page"] == np_ and last["y1"] > ny + 2:
                    safe = False  # crop runs into the next question's marker
        # solution removed = a region was capped clearly above the question's owned content bottom
        owned_bottom = 0.0
        for b in (q.get("boxes") or []):
            owned_bottom = max(owned_bottom, float(b.get("y1", 0)) if isinstance(b, dict) else 0)
        removed = bool(last and owned_bottom and last["y1"] < owned_bottom - 20)
        verdict = "PASS" if (crop_pass and safe) else "FAIL"
        if verdict == "FAIL":
            fails += 1
        rows.append((num, removed, own_pass, crop_pass, safe, verdict))

    print(f"{'Q':>4} {'SolRemoved':>10} {'OwnPASS':>8} {'CropPASS':>9} {'NextSafe':>9}  verdict")
    for (num, removed, own, cp, safe, v) in rows:
        print(f"{str(num):>4} {str(removed):>10} {str(own):>8} {str(cp):>9} {str(safe):>9}  {v}")
    nremoved = sum(1 for r in rows if r[1])
    unsafe = [r[0] for r in rows if not r[4]]
    print(f"\nquestions={len(rows)} solutionsRemoved={nremoved} FAIL={fails} NEXT-QUESTION-UNSAFE={unsafe}")


if __name__ == "__main__":
    main(sys.argv)
