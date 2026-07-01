/* eslint-disable no-console */
// Mirrors removeColumnDivider's detection and prints the bands it would remove, per page,
// so we can see exactly which columns are targeted on a REAL PDF (over/under removal check).
import sharp from 'sharp';
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

const detect = (field: Uint8Array, w: number, h: number) => {
  const hist = new Uint32Array(256);
  for (let i = 0; i < field.length; i += 1) hist[field[i]] += 1;
  let acc = 0;
  let paper = 255;
  for (let v = 0; v < 256; v += 1) { acc += hist[v]; if (acc >= field.length * 0.95) { paper = v; break; } }
  const markThr = Math.max(80, Math.min(200, paper * 0.6));
  const minRun = Math.round(h * 0.33);
  const gapTol = Math.max(2, Math.round(h * 0.02));
  const runLen = new Int32Array(w);
  const rTop = new Int32Array(w);
  const rBot = new Int32Array(w);
  for (let x = 0; x < w; x += 1) {
    let bestLen = 0, bestTop = 0, bestBot = -1, curTop = -1, curBot = -1, gap = 0;
    for (let y = 0; y < h; y += 1) {
      if (field[y * w + x] < markThr) { if (curTop < 0) curTop = y; curBot = y; gap = 0; }
      else if (curTop >= 0) { gap += 1; if (gap > gapTol) { if (curBot - curTop + 1 > bestLen) { bestLen = curBot - curTop + 1; bestTop = curTop; bestBot = curBot; } curTop = -1; gap = 0; } }
    }
    if (curTop >= 0 && curBot - curTop + 1 > bestLen) { bestLen = curBot - curTop + 1; bestTop = curTop; bestBot = curBot; }
    runLen[x] = bestLen; rTop[x] = bestTop; rBot[x] = bestBot;
  }
  const isLine = (x: number) => runLen[x] >= minRun;
  const maxThick = Math.max(3, Math.round(w * 0.02));
  const clear = Math.max(4, Math.round(w * 0.015));
  const bands: string[] = [];
  for (let xs = 0; xs < w;) {
    if (!isLine(xs)) { xs += 1; continue; }
    let xe = xs; while (xe + 1 < w && isLine(xe + 1)) xe += 1;
    const thickness = xe - xs + 1;
    let vtop = h, vbot = -1;
    for (let x = xs; x <= xe; x += 1) { if (rTop[x] < vtop) vtop = rTop[x]; if (rBot[x] > vbot) vbot = rBot[x]; }
    let reason = 'REMOVE';
    if (thickness > maxThick) reason = `keep(thick ${thickness}>${maxThick})`;
    else if (xs - 1 - clear < 0 || xe + 1 + clear >= w) reason = 'keep(edge)';
    else {
      const ink = (a: number, b: number) => { let nb = 0, tot = 0; for (let y = vtop; y <= vbot; y += 1) for (let x = a; x <= b; x += 1) { tot += 1; if (field[y * w + x] < markThr) nb += 1; } return nb / tot; };
      const li = ink(xs - 1 - clear, xs - 2), ri = ink(xe + 2, xe + 1 + clear);
      if (li > 0.04 || ri > 0.04) reason = `keep(gutter L=${li.toFixed(3)} R=${ri.toFixed(3)})`;
    }
    bands.push(`x=[${xs}..${xe}] th=${thickness} y=[${vtop}..${vbot}] (${(((vbot - vtop) / h) * 100).toFixed(0)}%) → ${reason}`);
    xs = xe + 1;
  }
  return { paper, markThr, bands };
};

const main = async () => {
  const file = process.argv[2];
  const fs = await import('fs');
  const bytes = new Uint8Array(fs.readFileSync(file));
  const { pdf } = await esmImport('pdf-to-img');
  const doc = await pdf(bytes, { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) { pages.push(p as Buffer); if (pages.length >= 2) break; }
  for (let i = 0; i < pages.length; i += 1) {
    const { data, info } = await sharp(pages[i]).greyscale().raw().toBuffer({ resolveWithObject: true });
    const r = detect(new Uint8Array(data.buffer, data.byteOffset, data.length), info.width!, info.height!);
    console.log(`\n${file.split('/').pop()} PAGE ${i + 1} ${info.width}x${info.height} paper=${r.paper} markThr=${r.markThr.toFixed(0)}`);
    if (!r.bands.length) console.log('  (no full-height vertical lines)');
    for (const b of r.bands) console.log('  ' + b);
  }
};
main().catch((e) => { console.error(e); process.exit(1); });
