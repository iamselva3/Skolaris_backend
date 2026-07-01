"""Trace page 7 markers through the pipeline to find duplicate Q56 source."""
import json
from app.structure_engine.models import DocumentInput
from app.structure_engine.geometry import compute_metrics
from app.structure_engine.marker_extractor import extract_markers
from app.structure_engine.page_classifier import classify_page
from app.structure_engine.models import PageKind
from app.structure_engine.marker_reconciler import reconcile_markers
CAP = (
    "crop-trace-out/capture/"
    "tenants_c2b13eeb-211c-4ee3-a9a4-a691b879107b_ocr-figures_"
    "e1ac37b9-6ad5-47f4-bb8e-283c32123726_merged.tokens.json"
)

with open(CAP, encoding="utf-8", errors="replace") as f:
    cap = json.load(f)

doc = DocumentInput.from_dict(cap)
metrics_by_page = {p.index: compute_metrics(p) for p in doc.pages}

# Step 1b: extract markers for pages with none
for p in doc.pages:
    if not p.markers:
        p.markers = extract_markers(p.words, metrics_by_page[p.index])

print("=== After step 1b (extract_markers) ===")
for p in doc.pages:
    nums = [m.num for m in p.markers if m.num is not None]
    if 56 in nums:
        print(f"  page {p.index} ({p.width}x{p.height}): Q56 present! all_nums={nums}")

# Step 2: classify pages
page_classes = [classify_page(p, metrics_by_page[p.index]) for p in doc.pages]
qpage_indices = {pc.index for pc in page_classes if pc.kind == PageKind.QUESTION}
qpages = [p for p in doc.pages if p.index in qpage_indices]
print(f"\n=== qpage_indices: {sorted(qpage_indices)} ===")

# Step 2b: reconcile_markers
recon = reconcile_markers(qpages, metrics_by_page)
print(f"\n=== After reconcile_markers ===")
print(f"recon.duplicates: {recon.duplicates}")
print(f"recon.restarts: {recon.restarts}")

# Apply canonical markers
for p in qpages:
    p.markers = recon.canonical_by_page.get(p.index, [])

print("\n=== After p.markers = canonical_by_page ===")
for p in doc.pages:
    nums = [m.num for m in p.markers if m.num is not None]
    if 56 in nums:
        print(f"  page {p.index}: Q56 STILL present! all_nums={nums}")
    elif p.index in qpage_indices:
        nums_all = [m.num for m in p.markers if m.num is not None]
        if nums_all:
            print(f"  page {p.index}: no Q56, nums={nums_all[:5]}")

# Check canonical_by_page[7] directly
print(f"\n=== canonical_by_page[7] markers ===")
for mk in recon.canonical_by_page.get(7, []):
    print(f"  num={mk.num} x0={mk.x0:.1f} y0={mk.y0:.1f}")

# Run _reconcile_group for the 1337x1891 group and trace Q56
from collections import defaultdict
from app.structure_engine.marker_reconciler import _reconcile_group
groups: dict = defaultdict(list)
for p in doc.pages:
    groups[(round(p.width), round(p.height))].append(p)

grp1337 = groups.get((1337, 1891), [])
print(f"\n=== _reconcile_group 1337x1891 ({len(grp1337)} pages) ===")
r = _reconcile_group(grp1337, metrics_by_page)
print(f"accepted={r.accepted} duplicates={r.duplicates} restarts={r.restarts}")
print(f"canonical[7] nums={[m.num for m in r.canonical_by_page.get(7, [])][:20]}")
