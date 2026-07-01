"""REGRESSION REPORTER — executes the EXISTING pipeline (every validator) against the 6 acceptance
papers and prints the per-PDF report + a stage trace for every failed question. It builds NO new
validator: it runs `analyze_document` (which runs ownership / crop / cross-page / cross-column /
option / badge / header-footer / neighbour validators) and formats their output.

The 6 papers are the SINGLE SOURCE OF TRUTH. A paper PASSES only when delivered == cropValid ==
logical == EXPECTED and every failure category is zero. 49/50 is a FAIL.

Run:  STRUCTURE_NUMBER_OCR=1 .venv/Scripts/python.exe regression_report.py
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:  # noqa: BLE001
    pass

from app.structure_engine.pipeline import analyze_document  # noqa: E402

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tmp", "baselines")
# (token file, label, HARD expected count) — the user's acceptance papers.
PAPERS = [
    ("phyche.tokens.json", "PHYCHE", 50),
    ("biology.tokens.json", "Biology", 85),
    ("biology_cell.tokens.json", "Biology_Cell", 90),
    ("25rep.tokens.json", "RE NEET / 25REP", 180),
    ("ad2601.tokens.json", "AD2601", 180),
    ("aiots_dr09.tokens.json", "AIOTS_DR09", 180),
]


def _stage_and_fix(q: dict) -> tuple[str, str]:
    """Derive the failure STAGE + FIX-NEEDED from a question's validator signals (no new logic —
    pure mapping of the existing deliveryReport / ownership flags)."""
    dr = q.get("deliveryReport") or {}
    num = q.get("number")
    if num is None:
        return "Badge / marker detection", "Recover the question number (badge/handwritten) — do not drop the owner."
    if q.get("neighborLeak"):
        return "Neighbour leak", "Truncate the crop at the next owner's marker; another question leaked in."
    opt, exp = dr.get("optionCount", 0), dr.get("expectedOptions", 0)
    if not q.get("hasDiagram") and exp >= 2 and opt < exp:
        if q.get("multiPage"):
            return "Cross-page option ownership", "Recover the options spilled to the top of the next page."
        if q.get("multiColumn"):
            return "Cross-column option ownership", "Recover the options spilled to the top of the next column."
        return "Option ownership (clipped)", f"Only {opt}/{exp} options owned — search slab/cross-col/cross-page."
    if not q.get("cropValid"):
        return "Crop geometry", "Crop boundary invalid (edge cut / degenerate) — fix the owned region extent."
    if not q.get("cropAllowed"):
        return "Ownership", "Ownership not allowed (incomplete owner) — repair before delivery."
    return "Completeness", "; ".join(dr.get("reasons", []) or ["incomplete"])


def report_paper(path: str, label: str, expected: int) -> dict:
    cap = json.load(open(path, encoding="utf-8"))
    buf = io.StringIO()
    with contextlib.redirect_stderr(buf):  # silence the pipeline's own per-question table
        r = analyze_document(cap)
    qs = r["questions"]
    qc = r.get("questionCount", {})
    seq = r.get("sequence", {})
    integ = r.get("integrity", {})
    nnc = integ.get("nnc", {}) or {}

    logical = len(qs)
    crop_valid = sum(1 for q in qs if q.get("cropValid"))
    deliverable = sum(1 for q in qs if q.get("deliverable"))
    neighbor = sum(1 for q in qs if q.get("neighborLeak"))
    badge = sum(1 for q in qs if q.get("number") is None)
    xpage = sum(1 for q in qs if q.get("multiPage"))
    xcol = sum(1 for q in qs if q.get("multiColumn"))
    opt_clip = sum(
        1 for q in qs
        if not q.get("hasDiagram")
        and (q.get("deliveryReport") or {}).get("expectedOptions", 0) >= 2
        and (q.get("deliveryReport") or {}).get("optionCount", 0) < (q.get("deliveryReport") or {}).get("expectedOptions", 0)
    )

    def kind_fail(kind: str) -> int:
        return sum(1 for h in (r.get("ownershipHeatmap") or []) if (h.get("checks") or {}).get(kind) == "FAIL")

    missing = qc.get("missingQuestions") or seq.get("gaps") or []
    recovered = qc.get("recoveredQuestions") or []
    duplicates = seq.get("duplicates") or []
    q_zero = 1 if seq.get("questionZero") else 0
    impossible = len(seq.get("impossible") or [])
    conf_issues = sum(1 for q in qs if q.get("deliverable") and (q.get("confidencePct") or 0) < 100)

    # PASS only when EVERY criterion holds — exact count with all crops valid + deliverable, zero anomalies.
    fail_reasons = []
    if logical != expected:
        fail_reasons.append(f"logical {logical} != expected {expected}")
    if crop_valid != expected:
        fail_reasons.append(f"cropValid {crop_valid} != expected {expected}")
    if deliverable != expected:
        fail_reasons.append(f"deliverable {deliverable} != expected {expected}")
    for nm, v in (("missing", missing), ("duplicates", duplicates), ("impossible", [0] * impossible),
                  ("Q0", [0] * q_zero), ("neighborLeaks", [0] * neighbor), ("optionClips", [0] * opt_clip)):
        if v:
            fail_reasons.append(f"{nm}={len(v)}")
    is_pass = not fail_reasons

    print("=" * 72)
    print(f"{label}   {'PASS ✅' if is_pass else 'FAIL ❌'}")
    print("-" * 72)
    fields = [
        ("Expected", expected), ("Logical", logical), ("Ownership", qc.get("ownershipCount")),
        ("Crop (valid)", crop_valid), ("Delivered", deliverable),
        ("Missing", missing), ("Recovered", recovered), ("Duplicates", duplicates),
        ("Question0", q_zero), ("ImpossibleSequence", impossible),
        ("CrossPage", xpage), ("CrossColumn", xcol),
        ("HeaderFooterLeaks", kind_fail("header") + kind_fail("footer")),
        ("BadgeIssues", badge), ("NeighborLeaks", neighbor), ("OptionClips", opt_clip),
        ("DiagramIssues", kind_fail("diagram")), ("TableIssues", kind_fail("table")),
        ("FormulaIssues", kind_fail("equation")), ("ChemStructureIssues", kind_fail("chemical_structure")),
        ("ConfidenceIssues", conf_issues),
        ("Stage1 N=N=C", nnc.get("stage1", {}).get("pass")), ("Stage2 N=N=C", nnc.get("stage2", {}).get("status")),
        ("DeliveryGate", r.get("deliveryGate")), ("Recommendation", r.get("recommendation")),
    ]
    for k, v in fields:
        if isinstance(v, list):
            v = f"{len(v)} {v[:20]}" if v else "0"
        print(f"  {k:22s} {v}")

    # STAGE TRACE for every failed question — never stop at the count.
    failed = [q for q in qs if not q.get("deliverable") or not q.get("cropValid")]
    if failed or missing:
        print("  " + "-" * 68)
        print(f"  STAGE TRACE — {len(failed)} failed question(s), {len(missing)} missing number(s)")
        for q in failed[:60]:
            stage, fix = _stage_and_fix(q)
            dr = q.get("deliveryReport") or {}
            print(f"    Question {q.get('number')}  | opts {dr.get('optionCount')}/{dr.get('expectedOptions')} "
                  f"| xpg={'Y' if q.get('multiPage') else 'N'} xcol={'Y' if q.get('multiColumn') else 'N'} "
                  f"leak={'Y' if q.get('neighborLeak') else 'N'} cropValid={'Y' if q.get('cropValid') else 'N'}")
            print(f"        Failure Stage : {stage}")
            print(f"        Reason        : {'; '.join(dr.get('reasons', []) or ['n/a'])}")
            print(f"        Searched      : {dr.get('searchedRegions') or '[]'}  Recovered: {dr.get('optionsRecovered', 0)}")
            print(f"        Owner         : {'Valid' if q.get('cropAllowed') else 'Invalid'}")
            print(f"        Fix Needed    : {fix}")
        for m in (missing[:40] if isinstance(missing, list) else []):
            print(f"    Question {m}  | MISSING — Failure Stage: Marker/Badge detection | "
                  f"Fix Needed: recover the marker (badge/handwritten/glued) so the owner is created.")

    return {"label": label, "expected": expected, "logical": logical, "cropValid": crop_valid,
            "deliverable": deliverable, "pass": is_pass, "failReasons": fail_reasons}


def main() -> int:
    results = []
    for fname, label, expected in PAPERS:
        path = os.path.normpath(os.path.join(BASE, fname))
        if not os.path.exists(path):
            print(f"{label}: MISSING capture ({path})")
            results.append({"label": label, "pass": False, "failReasons": ["missing capture"]})
            continue
        try:
            results.append(report_paper(path, label, expected))
        except Exception as e:  # noqa: BLE001
            import traceback
            print(f"{label}: ERROR {repr(e)[:200]}")
            if os.environ.get("TB"):
                traceback.print_exc()
            results.append({"label": label, "pass": False, "failReasons": [f"error {repr(e)[:80]}"]})

    print("\n" + "#" * 72)
    print("# ACCEPTANCE SUMMARY (the 6 PDFs are the source of truth)")
    print("#" * 72)
    for r in results:
        tag = "PASS ✅" if r.get("pass") else "FAIL ❌"
        extra = "" if r.get("pass") else f"  <- {', '.join(r.get('failReasons', []))}"
        d = r.get("deliverable"); cv = r.get("cropValid"); ex = r.get("expected")
        nums = f"{d}/{ex} delivered, {cv}/{ex} cropValid" if d is not None else ""
        print(f"  {tag}  {r['label']:18s} {nums}{extra}")
    n_pass = sum(1 for r in results if r.get("pass"))
    print(f"\n  RESULT: {n_pass}/{len(results)} papers PASS")
    return 0 if n_pass == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
