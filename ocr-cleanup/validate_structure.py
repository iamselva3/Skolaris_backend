"""Phase B validation — runs the CV-only page-structure PROPOSAL against the real
reference PDFs and prints what Python proposes per document. PROPOSAL ONLY: it
changes nothing in OCR/persist; this is the evidence gate before promoting Phase B.

  ocr-cleanup/.venv/Scripts/python.exe validate_structure.py "C:/Users/hp/Downloads"
"""
import os
import sys
import time

from app.structure import analyze_document

TARGETS = [
    "AIOTS 1 & DR09 Q @ sk_0476.pdf",
    "RE NEET PST 3 (1).pdf",
    "AD 2601 Q.pdf",
    "PHYCHE.pdf",
    "Biology.pdf",
    "Biology_Cell.pdf",
]


def main() -> int:
    data_dir = sys.argv[1] if len(sys.argv) > 1 else "/data"
    print("=" * 76)
    print("PHASE B — PAGE-STRUCTURE PROPOSAL (CV only, no OCR, no AI)  —  proposal-only")
    print("=" * 76)
    for name in TARGETS:
        path = os.path.join(data_dir, name)
        if not os.path.exists(path):
            print(f"\n### {name}\n  NOT FOUND")
            continue
        with open(path, "rb") as fh:
            content = fh.read()
        t0 = time.time()
        rep = analyze_document(content, "application/pdf")
        dt = time.time() - t0
        if not rep.get("available"):
            print(f"\n### {name}\n  unavailable: {rep.get('reason')}")
            continue
        pages = rep["pages"]
        two_col = sum(1 for p in pages if p["columns"] == 2)
        tables = sum(1 for p in pages if p["hasTable"])
        figs = sum(1 for p in pages if p["figures"] > 0)
        blanks = sum(1 for p in pages if p["ignoreCandidate"])
        grids = sum(1 for p in pages if p["pageType"] == "grid-heavy")
        print(f"\n### {name}  [{rep['pageCount']} pages, {dt:.1f}s]")
        print(f"  2-column pages     : {two_col}/{rep['pageCount']}")
        print(f"  table pages        : {tables}")
        print(f"  pages with figures : {figs}")
        print(f"  blank/ignore pages : {blanks}")
        print(f"  grid-heavy (answer-key/correction CANDIDATES, TS confirms via OCR): {grids}")
        # show first 3 + any flagged pages
        flagged = [p for p in pages if p["ignoreCandidate"] or p["pageType"] == "grid-heavy"]
        sample = pages[:3] + [p for p in flagged if p not in pages[:3]][:4]
        for p in sample:
            print(f"    p{p['page']:>2}: type={p['pageType']:<10} cols={p['columns']} "
                  f"bands={p['textBands']:>3} figs={p['figures']} table={int(p['hasTable'])} "
                  f"density={p['density']}")
    print("\n" + "=" * 76)
    print("Proposal-only. No OCR/persist touched. TS reconciles these with its OCR text.")
    print("=" * 76)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
