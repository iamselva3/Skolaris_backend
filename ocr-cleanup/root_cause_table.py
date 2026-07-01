"""ROOT-CAUSE table for crop failures (no blind fixes). For each question print the spec's columns +
the EXACT stage that failed. Universal: derives everything from the engine's own analysis, no per-PDF
constant. Usage: python root_cause_table.py <capture.tokens.json> [q1 q2 ...]"""
from __future__ import annotations

import base64
import io
import json
import sys

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:  # noqa: BLE001
    pass
from PIL import Image  # noqa: E402

from app.structure_engine.models import DocumentInput  # noqa: E402
from app.structure_engine.geometry import compute_metrics  # noqa: E402
from app.structure_engine.figure_regions import detect_figure_regions  # noqa: E402
from app.structure_engine.pipeline import analyze_document  # noqa: E402


def main(argv):
    cap = json.load(open(argv[1], encoding="utf-8"))
    for p in cap["pages"]:
        if p.get("imageBase64") and not p.get("width"):
            im = Image.open(io.BytesIO(base64.b64decode(p["imageBase64"])))
            p["width"], p["height"] = im.width, im.height
    targets = [int(x) for x in argv[2:]] if len(argv) > 2 else None

    doc = DocumentInput.from_dict(cap)
    metrics = {p.index: compute_metrics(p) for p in doc.pages}
    figs_by_page = {p.index: detect_figure_regions(p, metrics[p.index].median_h, None) for p in doc.pages}
    res = analyze_document(cap)
    qs = res["questions"]
    bynum = {q.get("number"): q for q in qs}
    # next marker y per page/x for crop-span check
    starts = sorted(((int(q["number_box"][0]), float(q["number_box"][2]), q.get("number"))
                     for q in qs if q.get("number_box")), key=lambda t: (t[0], t[1]))
    exp_opts = res.get("questionCount", {}).get("expectedCount") or 4

    nums = targets or [q.get("number") for q in qs]
    print(f"{'Q':>4} {'Type':>13} {'XPage':>6} {'Protected':>9} {'DiagOwn':>7} {'4Opt':>5} {'Soln':>5} {'CropBnd':>7}  VERDICT | reason")
    for n in nums:
        q = bynum.get(n)
        if not q:
            print(f"{n:>4} {'-':>13} {'FAIL':>6}  *** NOT IN QUESTION SET (lost) ***")
            continue
        cr = q.get("cropRegions") or []
        sp = q.get("startPage") or q.get("start_page")
        ep = q.get("endPage") or q.get("end_page")
        oc = q.get("optionCount") or 0
        vr = q.get("visualRegions") or q.get("visual_regions") or []
        h = max((r["y1"] - r["y0"]) for r in cr) if cr else 0
        # figures inside this question's crop span (a diagram option present on the page but NOT owned)
        page_figs = []
        for r in cr:
            for f in figs_by_page.get(r["page"], []):
                if r["y0"] - 5 <= f[1] and f[3] <= r["y1"] + 5:
                    page_figs.append(f)
        # next start in same page+below the crop top
        my0 = float(q["number_box"][2]) if q.get("number_box") else (cr[0]["y0"] if cr else 0)
        nxt = next((y for (pg, y, num) in starts if pg == sp and y > my0 + 1 and num != n), None)

        xpage = "n/a" if sp == ep else ("PASS" if len(cr) > 1 else "FAIL")
        # protected: did the page have figures the question should own but doesn't?
        unowned_fig = len(page_figs) > len(vr)
        diag_in_crop = q.get("hasDiagram") or vr or page_figs
        protected = "PASS" if not unowned_fig else "FAIL"
        diagown = "PASS" if (not diag_in_crop or vr) else ("FAIL" if page_figs else "n/a")
        fouropt = "PASS" if oc >= exp_opts else ("n/a" if oc == 0 and diag_in_crop else "FAIL")
        # crop span: does it reach near the next marker? a tiny crop far above next marker = clipped
        cropbnd = "PASS"
        reason = ""
        last_y = max((r["y1"] for r in cr), default=0)
        if nxt and last_y < nxt - 4 * metrics[sp].median_h and h < 90:
            cropbnd = "FAIL"; reason = f"crop ends y{round(last_y)} but next marker y{round(nxt)} (clipped/false-marker)"
        if sp != ep and len(cr) <= 1:
            cropbnd = "FAIL"; reason = "cross-page: continuation page not owned"
        if unowned_fig and not reason:
            reason = f"{len(page_figs)-len(vr)} diagram(s) on page NOT owned (figure undetected/unassigned)"
        if oc < exp_opts and oc > 0 and not reason:
            reason = f"only {oc}/{exp_opts} options owned"
        verdict = "PASS" if (xpage != "FAIL" and protected == "PASS" and cropbnd == "PASS") else "FAIL"
        print(f"{n:>4} {str(q.get('questionType')):>13} {xpage:>6} {protected:>9} {diagown:>7} {fouropt:>5} {'?':>5} {cropbnd:>7}  {verdict} | {reason}")


if __name__ == "__main__":
    main(sys.argv)
