"""Trace exactly what _reconcile_group does with Q56 for AIOTS."""
import json
from collections import defaultdict
from app.structure_engine.models import DocumentInput
from app.structure_engine.geometry import compute_metrics
from app.structure_engine.marker_extractor import extract_markers
from app.structure_engine.page_classifier import classify_page
from app.structure_engine.models import PageKind
from app.structure_engine.marker_reconciler import _reconcile_group, _gather, _char_w, _question_margins, _bucket_key

CAP = (
    "crop-trace-out/capture/"
    "tenants_c2b13eeb-211c-4ee3-a9a4-a691b879107b_ocr-figures_"
    "e1ac37b9-6ad5-47f4-bb8e-283c32123726_merged.tokens.json"
)

with open(CAP, encoding="utf-8", errors="replace") as f:
    cap = json.load(f)

doc = DocumentInput.from_dict(cap)
metrics_by_page = {p.index: compute_metrics(p) for p in doc.pages}

# Step 1b
for p in doc.pages:
    if not p.markers:
        p.markers = extract_markers(p.words, metrics_by_page[p.index])

# Classify pages
page_classes = [classify_page(p, metrics_by_page[p.index]) for p in doc.pages]
qpage_indices = {pc.index for pc in page_classes if pc.kind == PageKind.QUESTION}

# Get 1337x1891 group
groups: dict = defaultdict(list)
for p in doc.pages:
    if p.index in qpage_indices:
        groups[(round(p.width), round(p.height))].append(p)

grp = groups.get((1337, 1891), [])
print(f"1337x1891 qpages: {sorted(p.index for p in grp)}")

# Run _gather
metrics = metrics_by_page
cands = _gather(grp, metrics)
print(f"\nTotal candidates: {len(cands)}")

# Print Q56 candidates specifically
q56_cands = [c for c in cands if c.value == 56]
print(f"\nQ56 candidates:")
for c in q56_cands:
    print(f"  page={c.page} col={c.col} x0={c.x0:.1f} y0={c.y0:.1f}")

# Show margin detection
char_w = _char_w(grp, metrics)
margins = _question_margins(cands, char_w)
print(f"\nDetected margins: {sorted(margins)[:10]} (total {len(margins)})")

# Check which Q56 are on-margin
for c in q56_cands:
    bk = _bucket_key(c, char_w)
    on = bk in margins
    print(f"  Q56 page={c.page}: bucket_key={bk} on_margin={on}")

# Print sequence up to Q56 detection
print(f"\n=== Sequence reconstruction around Q56 ===")
on_margin = [c for c in cands if not margins or _bucket_key(c, char_w) in margins]
last = 0
seen_values = set()
for i, c in enumerate(on_margin):
    v = c.value
    if v == 56 or (v > 50 and v < 62):
        status = "forward" if v > last else "backward"
        print(f"  i={i} page={c.page} col={c.col} y={c.y0:.0f} v={v} last={last} → {status}")
    if v > last:
        seen_values.add(v)
        last = v
