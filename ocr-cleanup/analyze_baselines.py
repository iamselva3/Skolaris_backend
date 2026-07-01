"""Analyze every dumped baseline capture and report the logical question count + missing, so the
marker_extractor changes can be regression-checked against each layout's known-good count.

  python analyze_baselines.py
"""
from __future__ import annotations

import base64
import glob
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

# Registry / prior known-good counts for regression context (None = not pinned).
EXPECTED = {
    "biology": 85, "biology_cell": 100, "phyche": 50,
    "ad2601": 178, "aiots_dr09": 180, "25rep": 180, "reneet_good": 180,
}


def main():
    caps = sorted(glob.glob("../tmp/baselines/*.tokens.json"))
    caps += ["../tmp/reneet_good.tokens.json"] if os.path.exists("../tmp/reneet_good.tokens.json") else []
    print(f"{'paper':16} {'pages':>5} {'logical':>7} {'expdGate':>8} {'known':>5} {'gate':>7}  missing")
    for c in caps:
        name = os.path.basename(c).replace(".tokens.json", "")
        d = json.load(open(c, encoding="utf-8"))
        for p in d["pages"]:
            if p.get("imageBase64") and not p.get("width"):
                im = Image.open(io.BytesIO(base64.b64decode(p["imageBase64"])))
                p["width"], p["height"] = im.width, im.height
        os.environ["STRUCTURE_NUMBER_OCR"] = "0"  # isolate the token-marker path (no RapidOCR recovery)
        res = analyze_document(d)
        qs = res.get("questions", [])
        qc = res.get("questionCount", {})
        miss = qc.get("missingQuestions") or []
        known = EXPECTED.get(name, "?")
        print(f"{name:16} {len(d['pages']):>5} {len(qs):>7} {str(qc.get('expectedCount')):>8} "
              f"{str(known):>5} {str(res.get('cropGate')):>7}  miss={len(miss)} {miss[:18]}")


if __name__ == "__main__":
    main()
