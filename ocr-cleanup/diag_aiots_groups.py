"""Check what resolution groups AIOTS forms in reconcile_markers."""
import json
from collections import defaultdict
from app.structure_engine.models import DocumentInput

CAP = (
    "crop-trace-out/capture/"
    "tenants_c2b13eeb-211c-4ee3-a9a4-a691b879107b_ocr-figures_"
    "e1ac37b9-6ad5-47f4-bb8e-283c32123726_merged.tokens.json"
)

with open(CAP, encoding="utf-8", errors="replace") as f:
    cap = json.load(f)

doc = DocumentInput.from_dict(cap)
pages = doc.pages
groups: dict = defaultdict(list)
for p in pages:
    groups[(round(p.width), round(p.height))].append(p)

print(f"Total pages: {len(pages)}")
print(f"Resolution groups: {len(groups)}")
for (w, h), grp in sorted(groups.items()):
    nums_per_page = {}
    for p in grp:
        nums = [m.num for m in p.markers if m.num is not None]
        if nums:
            nums_per_page[p.index] = nums
    all_nums = sorted(set(n for ns in nums_per_page.values() for n in ns))
    print(f"  {w}x{h}: {len(grp)} pages, q_nums={all_nums[:10]}...{all_nums[-5:] if len(all_nums) > 5 else ''}")

# Also check if sequence.duplicates comes from questions or markers
from app.structure_engine.pipeline import analyze_document
result = analyze_document(cap)
seq = result.get("sequence", {})
print(f"\nsequence.duplicates: {seq.get('duplicates', [])}")
# Check which pages have Q56 markers after reconciliation
from app.structure_engine.marker_reconciler import reconcile_markers
from app.structure_engine.geometry import compute_metrics
metrics_by_page = {p.index: compute_metrics(p) for p in pages}

# Filter to question pages only
qpages = [p for p in pages if any(m.num is not None for m in p.markers)]
recon = reconcile_markers(qpages, metrics_by_page)
q56_markers = [
    (pg, [m for m in ms if m.num == 56])
    for pg, ms in sorted(recon.canonical_by_page.items())
    if any(m.num == 56 for m in ms)
]
print(f"\nQ56 markers in canonical_by_page after reconciliation: {q56_markers}")
print(f"recon.restarts: {recon.restarts}")
