"""Side-by-side visual report: TS crop vs Python crop, per question number.

Reads two folders of qNNN.png crops (TS and Python), matches by question number,
renders a labelled composite per question (TS left | Python right), an index.html
gallery, and a metrics summary that flags Python crops that look clipped/incomplete
relative to their TS counterpart.

Usage:
  python compare_crops.py <tsDir> <pyDir> <outDir>
"""
from __future__ import annotations

import glob
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

PANEL_H = 720          # each crop scaled to this height for display
LABEL_H = 64
GAP = 24
PAD = 16
BG = (245, 246, 248)
INK = (20, 20, 22)
RED = (200, 40, 40)
GREEN = (30, 140, 60)
AMBER = (200, 120, 0)


def _font(sz: int):
    for name in ("arial.ttf", "DejaVuSans.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, sz)
        except Exception:  # noqa: BLE001
            continue
    return ImageFont.load_default()


F = _font(22)
FB = _font(26)
FS = _font(18)


def _scan(d: str) -> dict[int, str]:
    out: dict[int, str] = {}
    for f in glob.glob(os.path.join(d, "q*.png")):
        m = re.match(r"q(\d+)\.png$", os.path.basename(f))
        if m:
            out[int(m.group(1))] = f
    return out


def _edge_ink(im: Image.Image, dark: int = 130) -> dict:
    """Fraction of the right / bottom edge that carries dark ink — a clipping signal:
    if real content runs into the crop's right or bottom edge, the question was likely cut."""
    g = im.convert("L")
    w, h = g.size
    px = g.load()
    col = sum(1 for y in range(h) if px[w - 1, y] < dark)
    row = sum(1 for x in range(w) if px[x, h - 1] < dark)
    # also a 3px-deep band so a 1px white margin doesn't hide a clip
    band = max(1, min(4, w // 50))
    colb = sum(1 for y in range(h) for x in range(w - band, w) if px[x, y] < dark)
    return {
        "right_edge": round(col / max(1, h), 3),
        "bottom_edge": round(row / max(1, w), 3),
        "right_band": round(colb / max(1, h * band), 3),
    }


def _scaled(path: str | None):
    if not path or not os.path.exists(path):
        return None, None
    im = Image.open(path).convert("RGB")
    metrics = {"w": im.width, "h": im.height, **_edge_ink(im)}
    scale = PANEL_H / im.height
    disp = im.resize((max(1, int(im.width * scale)), PANEL_H))
    # cap very wide panels
    if disp.width > 900:
        disp = disp.crop((0, 0, 900, PANEL_H))
        metrics["display_cropped"] = True
    return disp, metrics


def _flag(ts_m, py_m) -> tuple[str, tuple]:
    """Heuristic verdict comparing the Python crop to the TS crop."""
    if py_m is None and ts_m is None:
        return "both missing", AMBER
    if py_m is None:
        return "PYTHON MISSING", RED
    if ts_m is None:
        return "TS missing (TS misnumbered?)", AMBER
    # area ratio
    pa = py_m["w"] * py_m["h"]
    ta = ts_m["w"] * ts_m["h"]
    ratio = pa / max(1, ta)
    clip = py_m["right_band"] > 0.05 or py_m["bottom_edge"] > 0.06
    if ratio < 0.45 and clip:
        return f"PY CLIPPED  ({int(ratio*100)}% of TS area, ink at edge)", RED
    if ratio < 0.45:
        return f"PY much smaller ({int(ratio*100)}% of TS area)", RED
    if clip:
        return "PY ink runs to edge (possible clip)", AMBER
    if ratio > 2.2:
        return f"PY larger ({int(ratio*100)}% of TS)", AMBER
    return "comparable", GREEN


def _panel(disp, metrics, title: str, sub_color):
    w = disp.width if disp else 360
    canvas = Image.new("RGB", (w, PANEL_H + LABEL_H), (255, 255, 255))
    d = ImageDraw.Draw(canvas)
    d.rectangle((0, 0, w, LABEL_H - 1), fill=(30, 33, 38))
    d.text((10, 8), title, font=FB, fill=(255, 255, 255))
    if metrics:
        d.text((10, 38), f"{metrics['w']}x{metrics['h']}  rEdge={metrics['right_band']} bEdge={metrics['bottom_edge']}",
                font=FS, fill=(200, 205, 210))
    else:
        d.text((10, 38), "— no crop —", font=FS, fill=(230, 120, 120))
    if disp:
        canvas.paste(disp, (0, LABEL_H))
    else:
        d.rectangle((0, LABEL_H, w, PANEL_H + LABEL_H), fill=(250, 240, 240))
        d.text((w // 2 - 50, LABEL_H + PANEL_H // 2), "MISSING", font=FB, fill=RED)
    return canvas


def main(argv):
    ts_dir, py_dir, out_dir = argv[1], argv[2], argv[3]
    os.makedirs(out_dir, exist_ok=True)
    tsm, pym = _scan(ts_dir), _scan(py_dir)
    nums = sorted(set(tsm) | set(pym))

    rows = []
    for n in nums:
        ts_disp, ts_met = _scaled(tsm.get(n))
        py_disp, py_met = _scaled(pym.get(n))
        verdict, color = _flag(ts_met, py_met)

        lp = _panel(ts_disp, ts_met, f"Q{n}  ·  TS crop", color)
        rp = _panel(py_disp, py_met, f"Q{n}  ·  PYTHON crop", color)
        W = lp.width + GAP + rp.width
        comp = Image.new("RGB", (W + 2 * PAD, lp.height + LABEL_H + 2 * PAD), BG)
        dd = ImageDraw.Draw(comp)
        dd.rectangle((0, 0, comp.width, LABEL_H - 1), fill=color)
        dd.text((PAD, 10), f"Q{n}   {verdict}", font=FB, fill=(255, 255, 255))
        comp.paste(lp, (PAD, LABEL_H + PAD))
        comp.paste(rp, (PAD + lp.width + GAP, LABEL_H + PAD))
        comp.save(os.path.join(out_dir, f"q{n:03d}.png"))
        rows.append({"n": n, "verdict": verdict, "color": color, "ts": ts_met, "py": py_met})

    # summary
    red = [r for r in rows if r["color"] == RED]
    amber = [r for r in rows if r["color"] == AMBER]
    green = [r for r in rows if r["color"] == GREEN]

    html = [
        "<!doctype html><meta charset=utf-8><title>TS vs Python crops — AIOTS</title>",
        "<style>body{font:14px system-ui;margin:0;background:#0f1115;color:#e8eaed}"
        "h1{padding:16px}.sum{padding:0 16px 16px}.q{margin:0 0 28px}"
        ".q img{width:100%;display:block;border-top:1px solid #222}"
        ".tag{display:inline-block;padding:2px 8px;border-radius:4px;color:#fff;font-weight:600}"
        "table{border-collapse:collapse;margin:8px 16px}td,th{border:1px solid #333;padding:4px 10px}</style>",
        "<h1>TS crop vs Python crop — AIOTS (per question)</h1>",
        f"<div class=sum><b>{len(rows)}</b> questions · "
        f"<span style='color:#e85'>RED {len(red)}</span> · "
        f"<span style='color:#fb0'>AMBER {len(amber)}</span> · "
        f"<span style='color:#5d6'>OK {len(green)}</span></div>",
        "<div class=sum><b>RED (Python clipped / much smaller / missing):</b> "
        + ", ".join(f"Q{r['n']}" for r in red) + "</div>",
    ]
    for r in rows:
        c = "#c82828" if r["color"] == RED else ("#c87800" if r["color"] == AMBER else "#1e8c3c")
        html.append(
            f"<div class=q><div style='padding:8px 16px'><span class=tag style='background:{c}'>"
            f"Q{r['n']}</span> &nbsp; {r['verdict']}</div>"
            f"<img loading=lazy src='q{r['n']:03d}.png'></div>"
        )
    open(os.path.join(out_dir, "index.html"), "w", encoding="utf-8").write("\n".join(html))

    print(f"questions={len(rows)} RED={len(red)} AMBER={len(amber)} OK={len(green)}")
    print("RED:", ", ".join(f"Q{r['n']}" for r in red))
    print(f"report -> {out_dir}\\index.html")


if __name__ == "__main__":
    main(sys.argv)
