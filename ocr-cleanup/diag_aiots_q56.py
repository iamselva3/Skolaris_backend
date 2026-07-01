"""Trace where the duplicate Q56 question comes from."""
import json
from app.structure_engine.pipeline import analyze_document

CAP = (
    "crop-trace-out/capture/"
    "tenants_c2b13eeb-211c-4ee3-a9a4-a691b879107b_ocr-figures_"
    "e1ac37b9-6ad5-47f4-bb8e-283c32123726_merged.tokens.json"
)

with open(CAP, encoding="utf-8", errors="replace") as f:
    cap = json.load(f)

result = analyze_document(cap)
qs = result.get("questions", [])

# Find all Q56 entries
q56_all = [q for q in qs if q.get("number") == 56]
print(f"Total Q56 questions in output: {len(q56_all)}")
for q in q56_all:
    print(f"  Q56: startPage={q.get('startPage')} endPage={q.get('endPage')} "
          f"cropValid={q.get('cropValid')} deliverable={q.get('deliverable')} "
          f"reviewReasons={q.get('reviewReasons')}")

# Check sequence
seq = result.get("sequence", {})
print(f"\nsequence.duplicates: {seq.get('duplicates', [])}")
print(f"integrity.status: {result.get('integrity', {}).get('status')}")

# Check how many questions near Q56 range
near = [q for q in qs if q.get("number") and 54 <= q.get("number") <= 60]
print(f"\nQuestions Q54-Q60:")
for q in sorted(near, key=lambda x: (x.get("startPage",0), x.get("number",0))):
    print(f"  Q{q.get('number')} startPage={q.get('startPage')} endPage={q.get('endPage')} "
          f"reviewReasons={q.get('reviewReasons')}")
