"""Detailed AIOTS delivery failure diagnosis."""
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

seq = result.get("sequence", {})
print("sequence.duplicates:", seq.get("duplicates", [])[:15])
print("sequence.violations:", seq.get("violations", [])[:10])
print("integrity.status:", result.get("integrity", {}).get("status"))
print("delivery_gate:", result.get("delivery_gate"))
print(f"cropGate: {result.get('cropGate')}")
print()

# Non-deliverable questions with valid crops
not_del = [q for q in qs if q.get("cropValid", True) and not q.get("deliverable", False)]
print(f"CropValid but NOT deliverable ({len(not_del)}):")
for q in not_del[:40]:
    num = q.get("number")
    dr = q.get("deliveryReport") or q.get("delivery_report") or {}
    nl = q.get("neighborLeak") or q.get("neighbor_leak")
    ca = q.get("cropAllowed") or q.get("crop_allowed")
    cv = q.get("cropValid") or q.get("crop_valid")
    cmp = q.get("complete")
    rr = q.get("reviewReasons") or q.get("review_reasons") or []
    print(
        f"  Q{num}: complete={cmp} cropAllowed={ca} neighborLeak={nl} "
        f"reviewReasons={rr[:3]} dr={list(dr.items())[:3]}"
    )
