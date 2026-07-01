"""Debug reconcile_markers to see where Q56 duplicate comes from in AIOTS."""
import json
from collections import defaultdict
from app.structure_engine.models import DocumentInput
from app.structure_engine.geometry import compute_metrics
from app.structure_engine.marker_extractor import extract_markers

CAP = (
    "crop-trace-out/capture/"
    "tenants_c2b13eeb-211c-4ee3-a9a4-a691b879107b_ocr-figures_"
    "e1ac37b9-6ad5-47f4-bb8e-283c32123726_merged.tokens.json"
)

with open(CAP, encoding="utf-8", errors="replace") as f:
    cap = json.load(f)

doc = DocumentInput.from_dict(cap)
metrics_by_page = {p.index: compute_metrics(p) for p in doc.pages}

# Simulate step 1b: extract markers if page has none
chrome = {}
for p in doc.pages:
    if not p.markers:
        p.markers = extract_markers(p.words, metrics_by_page[p.index], exclude=chrome.get(p.index, set()))

# Check marker numbers per page
print("=== Marker numbers per page (after extract_markers) ===")
all_marker_nums = {}
for p in doc.pages:
    nums = [m.num for m in p.markers if m.num is not None]
    if nums:
        all_marker_nums[p.index] = nums
        print(f"  page {p.index} ({p.width}x{p.height}): markers={nums[:10]}")

# Check resolution groups
groups: dict = defaultdict(list)
for p in doc.pages:
    groups[(round(p.width), round(p.height))].append(p)

print(f"\n=== Resolution groups ({len(groups)} groups) ===")
for (w, h), grp in sorted(groups.items()):
    page_nums = {}
    for p in grp:
        nums = [m.num for m in p.markers if m.num is not None]
        if nums:
            page_nums[p.index] = nums
    all_nums = sorted(set(n for ns in page_nums.values() for n in ns))
    print(f"  {w}x{h}: {len(grp)} pages, q_nums={all_nums[:10]}")

# Find duplicate Q56 in page markers
print("\n=== Pages with Q56 marker ===")
for p in doc.pages:
    if any(m.num == 56 for m in p.markers):
        print(f"  page {p.index} ({p.width}x{p.height}): has Q56 marker")
