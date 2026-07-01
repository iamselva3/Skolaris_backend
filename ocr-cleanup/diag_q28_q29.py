"""Trace Q28 and Q29 ownership through every stage to find why they regress from 50/50 to 48/50."""
from __future__ import annotations
import sys
import os
import json
import glob

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from app.structure_engine.pipeline import analyze_document

CAP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "crop-trace-out", "capture")
phyche_files = glob.glob(os.path.join(CAP_DIR, "*2d28720c*tokens.json"))
if not phyche_files:
    print("ERROR: No PHYCHE capture found at", CAP_DIR)
    sys.exit(1)

cap = json.load(open(phyche_files[0], encoding="utf-8"))
print(f"Running on capture: {os.path.basename(phyche_files[0])}")

r = analyze_document(cap)
qs = r["questions"]
logical = len(qs)
crop_valid = sum(1 for q in qs if q.get("cropValid"))
deliverable = sum(1 for q in qs if q.get("deliverable"))
print(f"Logical={logical}  CropValid={crop_valid}  Deliverable={deliverable}")
print(f"DeliveryGate={r.get('deliveryGate')}  CropGate={r.get('cropGate')}  Recommendation={r.get('recommendation')}")
print()

# Show ALL questions that are NOT deliverable
not_deliverable = [q for q in qs if not q.get("deliverable")]
print(f"NOT-DELIVERABLE QUESTIONS ({len(not_deliverable)}):")
for q in not_deliverable:
    dr = q.get("deliveryReport") or {}
    print(f"  Q{q.get('number','?'):3}  cropValid={q.get('cropValid')}  cropAllowed={q.get('cropAllowed')}  "
          f"opts={q.get('optionCount')}/expected  hasDiagram={q.get('hasDiagram')}  "
          f"neighborLeak={q.get('neighborLeak')}  "
          f"delivery_reasons={dr.get('reasons')}  "
          f"reviewReasons={q.get('reviewReasons')}")

print()
print(f"=== FULL TRACE FOR Q28 AND Q29 ===")

TARGET_NUMS = {28, 29}
for q in qs:
    n = q.get("number")
    if n not in TARGET_NUMS:
        continue
    or_ = q.get("ownershipReport") or {}
    dr = q.get("deliveryReport") or {}
    print(f"\nQuestion : {n}")
    print(f"Detected : yes (number={n})")
    print(f"Ownership : {'yes' if or_.get('ownerPass') else 'no'}")
    print(f"CrossPage : {'yes' if or_.get('crossPagePass') else 'no'}")
    print(f"CrossColumn : {'yes' if or_.get('crossColumnPass') else 'no'}")
    print(f"ProtectedRegion : {'yes' if or_.get('protectedRegionPass') else 'no'}")
    print(f"OptionValidation : {'yes' if or_.get('optionPass') else 'no'}")
    print(f"CropAllowed : {'yes' if or_.get('cropAllowed') else 'no'}")
    print(f"CropBuilt : {'yes' if q.get('cropRegions') else 'no'} (regions={len(q.get('cropRegions') or [])})")
    print(f"CropValid : {'yes' if q.get('cropValid') else 'no'}")
    print(f"Delivered : {'yes' if q.get('deliverable') else 'no'}")
    fail_reasons = or_.get('failureReasons') or []
    delivery_reasons = dr.get('reasons') or []
    review_reasons = q.get('reviewReasons') or []
    all_reasons = fail_reasons + delivery_reasons + review_reasons
    if not q.get('cropValid') or not q.get('cropAllowed') or q.get('neighborLeak') or not q.get('deliverable'):
        print(f"FailureStage : {'CropAllowed' if not or_.get('cropAllowed') else 'CropValid' if not q.get('cropValid') else 'NeighborLeak' if q.get('neighborLeak') else 'Deliverable'}")
    else:
        print(f"FailureStage : NONE (passing)")
    print(f"Reason : {all_reasons}")
    print()
    print(f"  number_box={q.get('numberBox')}")
    print(f"  option_count={q.get('optionCount')}  has_diagram={q.get('hasDiagram')}")
    print(f"  multi_page={q.get('multiPage')}  multi_column={q.get('multiColumn')}")
    print(f"  start_page={q.get('startPage')}  end_page={q.get('endPage')}")
    print(f"  boxes_count={len(q.get('boxes') or [])}")
    print(f"  crop_regions={q.get('cropRegions')}")
    print(f"  delivery_report: complete={dr.get('complete')} optCount={dr.get('optionCount')} expected={dr.get('expectedOptions')} recovered={dr.get('optionsRecovered')} searched={dr.get('searchedRegions')}")

print()
print("=== EXPECTED OPTIONS (inferred from paper) ===")
from app.structure_engine.crop_completeness_validator import infer_expected_options
from app.structure_engine.models import DocumentInput
DocumentInput.from_dict(cap)  # validate parse only
qids_with_opts = [(q.get("number"), q.get("optionCount")) for q in qs if q.get("optionCount", 0) >= 2]
print(f"Questions with >=2 options: count={len(qids_with_opts)}")
from collections import Counter
counts = [c for _, c in qids_with_opts]
if counts:
    dom = Counter(counts).most_common(3)
    print(f"Dominant option counts: {dom}")
expected = infer_expected_options([type("Q", (), {"option_count": c})() for c in counts])
print(f"Inferred expected_options = {expected}")
