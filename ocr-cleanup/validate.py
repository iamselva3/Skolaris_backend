"""Validation harness — runs the REAL cleanup engine against real production PDFs
and prints a per-PDF report (background / watermark / footer / header / logo /
border / divider removal) plus the hard CONTENT-DAMAGE check.

Run inside the CV image with the PDFs mounted, e.g.:
  docker run --rm -v "$PWD/ocr-cleanup:/app" -v "/c/Users/hp/Downloads:/data:ro" \
    -w /app skolaris-cleanup-cv python validate.py /data
"""
import os
import sys
import time

from app.cleanup import analyze

TARGETS = [
    "AIOTS 1 & DR09 Q @ sk_0476.pdf",
    "RE NEET PST 3 (1).pdf",
    "AD 2601 Q.pdf",
    "PHYCHE.pdf",
    "Biology.pdf",
    "Biology_Cell.pdf",
]


def mime_of(name: str) -> str:
    n = name.lower()
    if n.endswith(".pdf"):
        return "application/pdf"
    if n.endswith((".jpg", ".jpeg")):
        return "image/jpeg"
    if n.endswith(".png"):
        return "image/png"
    return "application/octet-stream"


def main() -> int:
    data_dir = sys.argv[1] if len(sys.argv) > 1 else "/data"
    print("=" * 74)
    print("DOCUMENT CLEANUP — VALIDATION REPORT (real engine, real PDFs)")
    print("=" * 74)
    total_damage = 0
    any_fail = False
    for name in TARGETS:
        path = os.path.join(data_dir, name)
        if not os.path.exists(path):
            print(f"\n### {name}\n  FILE NOT FOUND ({path})")
            any_fail = True
            continue
        with open(path, "rb") as fh:
            content = fh.read()
        t0 = time.time()
        try:
            out, changed, r = analyze(content, mime_of(name))
        except Exception as e:  # noqa: BLE001
            any_fail = True
            print(f"\n### {name}\n  ERROR: {type(e).__name__}: {e}")
            continue
        dt = time.time() - t0
        total_damage += r["content_damage_px"]
        print(f"\n### {name}  [{len(content) // 1024} KB, {r['pages']} pages, {dt:.1f}s]")
        print(f"  changed            : {changed}   (validated {r['validated_pages']}/{r['pages']} pages)")
        print(f"  background removal  : {r['background_px']:,} px")
        print(f"  watermark removal   : {r['watermark_px']:,} px")
        print(f"  footer removal      : {r['footer_objects']} obj / {r['footer_px']:,} px")
        print(f"  header removal      : {r['header_objects']} obj / {r['header_px']:,} px")
        print(f"  logo removal        : {r['logo_objects']} obj / {r['logo_px']:,} px")
        print(f"  border removal      : {r['border_objects']} obj / {r['border_px']:,} px")
        print(f"  divider removal     : {r['divider_objects']} obj / {r['divider_px']:,} px")
        print(f"  speck/noise removal : {r['speck_objects']} obj / {r['speck_px']:,} px")
        print(f"  min ink retention   : {r['min_ink_retention'] * 100:.1f}%")
        print(f"  CONTENT DAMAGE      : {r['content_damage_px']} px  "
              f"({'OK' if r['content_damage_px'] == 0 else 'DAMAGE!'})")
        out_kb = (len(out) // 1024) if changed else len(content) // 1024
        print(f"  output              : {'cleaned' if changed else 'ORIGINAL (kept)'} ({out_kb} KB)")

    print("\n" + "=" * 74)
    verdict = "PASS" if (total_damage == 0 and not any_fail) else "FAIL"
    print(f"TOTAL CONTENT DAMAGE across all PDFs = {total_damage} px   →   {verdict}")
    print("=" * 74)
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
