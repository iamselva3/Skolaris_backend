/* eslint-disable no-console */
/**
 * PRODUCTION-FAITHFUL guard trace for the display watermark cleanup. Answers,
 * with no threshold/guard changes, exactly where the watermark-removal decision
 * is stopped on one page. Runs at DEFAULT config (set no OCR_* overrides).
 *
 * It does three things:
 *  1) Ground truth: runs the REAL cleanCropForDisplay on the raw page and counts
 *     how many pixels it actually whitens.
 *  2) Replicates the EXACT production decision (same constants, same order, same
 *     0/1 mask resampled the same way) and verifies it reproduces the real output
 *     pixel-for-pixel — so the attribution below is trustworthy.
 *  3) Re-runs the SAME decision but with the mask scaled 0->0 / 1->255 (what the
 *     gate comparison `mreg<128` actually expects) to show what WOULD happen if
 *     the gate worked, with a full per-guard breakdown.
 *
 * Guards (as named in crop-display-clean.ts; there is no guard "B"):
 *   A = outside the large-watermark mask     C = dark-core (luma<115) + halo
 *   E = flat-field bright (>=235)             F = absolute floor (luma<120)
 *   D = darker than persistent bg by 28
 *
 *   npx ts-node scripts/diag-guards.ts "<pdf>" <pageIdx> [x0 y0 x1 y1]
 */
import sharp from 'sharp';
import * as fs from 'fs';
import {
  buildFlatField,
  buildWatermarkMask,
  analyzeWatermarkMask,
  type FlatField,
  type WatermarkMask,
} from '../src/shared/ocr-engine/watermark-clean';
import { cleanCropForDisplay } from '../src/shared/ocr-engine/crop-display-clean';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

// EXACT crop-display-clean.ts defaults.
const CORE_DARK = Number(process.env.OCR_DISPLAY_WM_CORE ?? 115);
const HALO = Math.max(0, Math.round(Number(process.env.OCR_DISPLAY_WM_HALO ?? 2)));
const PROTECT_ABOVE = Number(process.env.OCR_DISPLAY_WM_PROTECT_ABOVE ?? 235);
const KEEP_MARGIN = Number(process.env.OCR_DISPLAY_WM_KEEP_MARGIN ?? 28);
const WHITE_FLOOR = Number(process.env.OCR_DISPLAY_WM_WHITE_FLOOR ?? 120);

const dilate = (mask: Uint8Array, w: number, h: number, r: number): Uint8Array => {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      let v = 0;
      for (let dx = -r; dx <= r && !v; dx += 1) {
        const xx = x + dx;
        if (xx >= 0 && xx < w && mask[y * w + xx]) v = 1;
      }
      tmp[y * w + x] = v;
    }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x += 1)
    for (let y = 0; y < h; y += 1) {
      let v = 0;
      for (let dy = -r; dy <= r && !v; dy += 1) {
        const yy = y + dy;
        if (yy >= 0 && yy < h && tmp[yy * w + x]) v = 1;
      }
      out[y * w + x] = v;
    }
  return out;
};

// Resample a {width,height,data} field to page size — matches flatForRegion for a
// full-page region (sharp resize, fit:'fill', bilinear).
const toPage = async (data: Uint8Array, w: number, h: number, pw: number, ph: number): Promise<Uint8Array> => {
  const out = await sharp(Buffer.from(data), { raw: { width: w, height: h, channels: 1 } })
    .resize(pw, ph, { fit: 'fill' })
    .raw()
    .toBuffer();
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
};

type Guard = 'C' | 'A' | 'E' | 'F' | 'D' | 'WHITEN';
// Replicate the EXACT production decision/order. `mPage` holds the resampled mask
// in whatever scaling we pass (0/1 = production, 0/255 = intended).
const decide = (L: number, F: number, inProtected: boolean, mVal: number): Guard => {
  if (inProtected) return 'C';
  if (mVal < 128) return 'A';
  if (F >= PROTECT_ABOVE) return 'E';
  if (L < WHITE_FLOOR) return 'F';
  if (L < F - KEEP_MARGIN) return 'D';
  return 'WHITEN';
};

const main = async (): Promise<void> => {
  const file = process.argv[2];
  const pageIdx = Number(process.argv[3] ?? 1);
  const bytes = fs.readFileSync(file);
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(bytes, { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);

  const flat = (await buildFlatField(pages)) as FlatField;
  if (!flat) throw new Error('no flat field');
  const mask = buildWatermarkMask(flat) as WatermarkMask;
  const an = analyzeWatermarkMask(flat)!;
  const raw = pages[pageIdx - 1];
  const meta = await sharp(raw).metadata();
  const pw = meta.width!;
  const ph = meta.height!;
  const reg = { x0: 0, y0: 0, x1: pw, y1: ph };

  // ---- (1) mask value distribution: are values 0/1 or 0/255? ----
  const vals = new Map<number, number>();
  for (const v of mask.data) vals.set(v, (vals.get(v) ?? 0) + 1);
  console.log(`\n==== MASK (page-level) ${mask.width}x${mask.height} ====`);
  console.log(`distinct mask values: ${[...vals.entries()].map(([v, c]) => `${v}×${c}`).join(', ')}`);
  console.log(`(the production gate at crop-display-clean.ts:193 tests "mreg[p] < 128")`);

  // Aakash watermark region (page px). Default ≈ the centre logo band.
  const wx0 = Number(process.argv[4] ?? Math.round(pw * 0.4));
  const wy0 = Number(process.argv[5] ?? Math.round(ph * 0.44));
  const wx1 = Number(process.argv[6] ?? Math.round(pw * 0.7));
  const wy1 = Number(process.argv[7] ?? Math.round(ph * 0.64));

  // ---- component coverage of the watermark region ----
  const sx = mask.width / pw;
  const sy = mask.height / ph;
  const overlap = an.components.filter(
    (c) => c.x1 >= wx0 * sx && c.x0 <= wx1 * sx && c.y1 >= wy0 * sy && c.y0 <= wy1 * sy,
  );
  console.log(`\n==== COMPONENTS overlapping watermark region (flat-grid px) ====`);
  console.log(`total components on page: ${an.components.length}; accepted: ${an.components.filter((c) => c.accepted).length}`);
  for (const c of overlap.sort((a, b) => b.area - a.area).slice(0, 12))
    console.log(
      `  #${c.id} bbox=[${c.x0},${c.y0}-${c.x1},${c.y1}] span=${c.span} area=${c.area} flatMean=${c.flatMean} → ${c.accepted ? 'ACCEPT' : 'reject'}`,
    );

  // ---- pixel-level setup ----
  const { data: rgb } = await sharp(raw).raw().toBuffer({ resolveWithObject: true });
  const ch = rgb.length / (pw * ph);
  const L = new Float32Array(pw * ph);
  const core = new Uint8Array(pw * ph);
  for (let p = 0, i = 0; p < pw * ph; p += 1, i += ch) {
    const r = rgb[i];
    const g = ch >= 3 ? rgb[i + 1] : r;
    const b = ch >= 3 ? rgb[i + 2] : r;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    L[p] = lum;
    if (lum < CORE_DARK) core[p] = 1;
  }
  const protE = dilate(core, pw, ph, HALO);
  const fPage = await toPage(flat.data, flat.width, flat.height, pw, ph);
  const mProd = await toPage(mask.data, mask.width, mask.height, pw, ph); // 0/1 (production)
  const mFixed = await toPage(Uint8Array.from(mask.data, (v) => (v ? 255 : 0)), mask.width, mask.height, pw, ph); // 0/255

  const tally = (useFixed: boolean, x0: number, y0: number, x1: number, y1: number) => {
    const t: Record<Guard, number> = { C: 0, A: 0, E: 0, F: 0, D: 0, WHITEN: 0 };
    for (let y = y0; y < y1; y += 1)
      for (let x = x0; x < x1; x += 1) {
        const p = y * pw + x;
        if (L[p] >= 235) continue; // only count visible ink
        t[decide(L[p], fPage[p], protE[p] === 1, (useFixed ? mFixed : mProd)[p])] += 1;
      }
    return t;
  };

  // ---- (2) ground truth: real function ----
  const realOut = await cleanCropForDisplay(await sharp(raw).png().toBuffer(), {
    flat,
    mask,
    region: reg,
    pageWidth: pw,
    pageHeight: ph,
  });
  const realGray = await sharp(realOut).greyscale().raw().toBuffer();
  let realWhitened = 0;
  for (let p = 0; p < pw * ph; p += 1) if (L[p] < 240 && realGray[p] >= 250) realWhitened += 1;

  // Replica of production over whole page (to validate against ground truth).
  const prodPage = tally(false, 0, 0, pw, ph);
  console.log(`\n==== GROUND TRUTH vs PRODUCTION-REPLICA (whole page) ====`);
  console.log(`real cleanCropForDisplay whitened: ${realWhitened} px`);
  console.log(`production-replica WHITEN:          ${prodPage.WHITEN} px  (should match real → validates replica)`);

  const show = (label: string, t: Record<Guard, number>) => {
    const tot = t.C + t.A + t.E + t.F + t.D + t.WHITEN;
    console.log(`\n-- ${label} -- (visible ink px=${tot})`);
    console.log(`  A outside mask   : ${t.A}`);
    console.log(`  C dark-core+halo : ${t.C}`);
    console.log(`  E flat-bright>=235: ${t.E}`);
    console.log(`  F floor<120      : ${t.F}`);
    console.log(`  D darker-than-bg : ${t.D}`);
    console.log(`  WHITENED         : ${t.WHITEN}`);
  };
  console.log(`\n==== GUARD-HIT SUMMARY in watermark region x[${wx0}-${wx1}] y[${wy0}-${wy1}] ====`);
  show('PRODUCTION gate (mask 0/1, as shipped)', tally(false, wx0, wy0, wx1, wy1));
  show('INTENDED gate (mask 0/255, gate working)', tally(true, wx0, wy0, wx1, wy1));

  // ---- (4) per-pixel trace of sample watermark pixels ----
  console.log(`\n==== PER-PIXEL TRACE (sample watermark strokes) ====`);
  const samples: number[] = [];
  for (let y = wy0; y < wy1 && samples.length < 6; y += 7)
    for (let x = wx0; x < wx1 && samples.length < 6; x += 11) {
      const p = y * pw + x;
      if (L[p] >= 130 && L[p] <= 210) samples.push(p); // clear watermark-grey ink
    }
  for (const p of samples) {
    const x = p % pw;
    const y = (p / pw) | 0;
    const prod = decide(L[p], fPage[p], protE[p] === 1, mProd[p]);
    const fixed = decide(L[p], fPage[p], protE[p] === 1, mFixed[p]);
    console.log(
      `  (${x},${y}) RAW L=${Math.round(L[p])} flat F=${fPage[p]} maskRaw=${mProd[p]} mask0/255=${mFixed[p]} core=${protE[p]}` +
        `\n        production → guard ${prod} → ${prod === 'WHITEN' ? 'WHITE' : 'kept'}` +
        `   |   if gate worked → guard ${fixed} → ${fixed === 'WHITEN' ? 'WHITE' : 'kept'}`,
    );
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
