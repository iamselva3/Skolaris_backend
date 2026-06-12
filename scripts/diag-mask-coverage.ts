/* eslint-disable no-console */
/**
 * REMAINING-WATERMARK + MASK-COVERAGE analysis, with BOTH validated flags ON
 * (BG_TRAIL + PERSISTENT_CORE). Answers, with evidence and NO code change:
 *   1. how much watermark remains and WHY it survives (guard breakdown)
 *   2. how much of it is OUTSIDE the large mask, and how far from the mask it sits
 *   3. how much is RECOVERABLE by growing the mask (dilate radius r, flat-grid px),
 *      and at what COST to content (unique-content pixels newly swept under the mask,
 *      and recovered pixels sitting NEXT TO content = the only real risk zone).
 *
 * The mask is grown the same way the real lever would (dilate mask.data at flat
 * resolution, then resample) and fed straight into the REAL cleanCropForDisplay, so
 * the "recoverable" numbers are production-faithful. Nothing is written back.
 *
 *   npx ts-node scripts/diag-mask-coverage.ts "<pdf>"
 */
import sharp from 'sharp';
import { buildFlatField, buildWatermarkMask } from '../src/shared/ocr-engine/watermark-clean';
import { cleanCropForDisplay } from '../src/shared/ocr-engine/crop-display-clean';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

const PROTECT_ABOVE = 235;
const KEEP_MARGIN = 28;
const BG_HARD_INK = 110;
const RADII = [2, 4, 6, 8, 12, 16]; // flat-grid px (WM_MASK_DILATE default is 4)

const lumaOf = async (png: Buffer): Promise<Uint8Array> => {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  const d = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < w * h; p += 1, i += channels) {
    const r = data[i];
    const g = channels >= 3 ? data[i + 1] : r;
    const b = channels >= 3 ? data[i + 2] : r;
    d[p] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return d;
};
const resampleTo = async (src: Uint8Array, sw: number, sh: number, w: number, h: number): Promise<Uint8Array> => {
  const b = await sharp(Buffer.from(src), { raw: { width: sw, height: sh, channels: 1 } })
    .resize(w, h, { fit: 'fill' })
    .toColourspace('b-w')
    .raw()
    .toBuffer();
  return new Uint8Array(b.buffer, b.byteOffset, b.length);
};
const dilate = (m: Uint8Array, w: number, h: number, r: number): Uint8Array => {
  if (r <= 0) return m;
  const t = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      let v = 0;
      for (let dx = -r; dx <= r && !v; dx += 1) {
        const xx = x + dx;
        if (xx >= 0 && xx < w && m[y * w + xx]) v = 1;
      }
      t[y * w + x] = v;
    }
  const o = new Uint8Array(w * h);
  for (let x = 0; x < w; x += 1)
    for (let y = 0; y < h; y += 1) {
      let v = 0;
      for (let dy = -r; dy <= r && !v; dy += 1) {
        const yy = y + dy;
        if (yy >= 0 && yy < h && t[yy * w + x]) v = 1;
      }
      o[y * w + x] = v;
    }
  return o;
};

const main = async (): Promise<void> => {
  const file = process.argv[2];
  const bytes = require('fs').readFileSync(file);
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(bytes, { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  const flat = await buildFlatField(pages);
  if (!flat) throw new Error('no flat');
  const mask = buildWatermarkMask(flat);
  if (!mask) throw new Error('no mask');
  // mask as flat-grid 0/1 for dilation.
  const mask01 = Uint8Array.from(mask.data, (v) => (v ? 1 : 0));
  const extMasks: Record<number, Uint8Array> = {};
  // dilate the 0/1 mask, then emit 0/255 so the post-resample `>=128` test works
  // (a 0/1 field resamples to ~0/1 and would never cross 128 — silent no-op).
  for (const r of RADII)
    extMasks[r] = Uint8Array.from(dilate(mask01, mask.width, mask.height, r), (v) => (v ? 255 : 0));
  console.log(`pages=${pages.length} flat=${flat.width}x${flat.height}\n`);

  let footTot = 0;
  let remainTot = 0;
  let outDarkTot = 0;
  let outHaloTot = 0;
  let inMaskVisTot = 0;
  const recov: Record<number, number> = {};
  const recovNearContent: Record<number, number> = {};
  const contentSwept: Record<number, number> = {};
  for (const r of RADII) {
    recov[r] = 0;
    recovNearContent[r] = 0;
    contentSwept[r] = 0;
  }

  for (let i = 0; i < pages.length; i += 1) {
    const raw = pages[i];
    const meta = await sharp(raw).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    const n = W * H;
    const region = { x0: 0, y0: 0, x1: W, y1: H };

    process.env.OCR_DISPLAY_BG_TRAIL = 'true';
    process.env.OCR_DISPLAY_WM_PERSISTENT_CORE = 'true';
    const test = await cleanCropForDisplay(raw, { flat, mask, region, pageWidth: W, pageHeight: H });
    delete process.env.OCR_DISPLAY_BG_TRAIL;
    delete process.env.OCR_DISPLAY_WM_PERSISTENT_CORE;

    const R = await lumaOf(raw);
    const T = await lumaOf(test);
    const F = await resampleTo(flat.data, flat.width, flat.height, W, H);
    const M0 = await resampleTo(mask.data, mask.width, mask.height, W, H);
    const Mr: Record<number, Uint8Array> = {};
    for (const r of RADII) Mr[r] = await resampleTo(extMasks[r], mask.width, mask.height, W, H);

    // unique-content proximity map (within 3 page-px of a flat-bright pixel).
    const bright = new Uint8Array(n);
    for (let p = 0; p < n; p += 1) if (F[p] >= PROTECT_ABOVE) bright[p] = 1;
    const nearContent = dilate(bright, W, H, 3);

    for (let p = 0; p < n; p += 1) {
      const L = R[p];
      const f = F[p];
      const isFoot = f < PROTECT_ABOVE && L < 235 && L >= f - KEEP_MARGIN;
      if (!isFoot) {
        // structural-net cost: unique content newly swept under the grown mask.
        if (bright[p]) for (const r of RADII) if (M0[p] < 128 && Mr[r][p] >= 128) contentSwept[r] += 1;
        continue;
      }
      footTot += 1;
      const remaining = T[p] < 235; // still visible after both flags
      if (!remaining) continue;
      remainTot += 1;
      const inMask = M0[p] >= 128;
      if (inMask) inMaskVisTot += 1;
      else if (L < BG_HARD_INK) outDarkTot += 1; // dark logo outside mask (BG_TRAIL ink-kept)
      else outHaloTot += 1; // medium, outside mask, near dark ink (halo-kept)
      // recoverable by a grown mask: comes inside the extended mask.
      for (const r of RADII) {
        if (!inMask && Mr[r][p] >= 128) {
          recov[r] += 1;
          if (nearContent[p]) recovNearContent[r] += 1;
        }
      }
    }
    process.stdout.write(`\rpage ${i + 1}/${pages.length}`);
  }
  console.log('\n');

  const pct = (x: number, d: number) => (d ? `${Math.round((x / d) * 1000) / 10}%` : '0%');
  console.log(`==== REMAINING WATERMARK (both flags ON) ====`);
  console.log(`watermark-ink footprint .............. ${footTot}`);
  console.log(`remaining (still visible) ............ ${remainTot}  (${pct(remainTot, footTot)} of footprint)`);
  console.log(`  outside mask, DARK (logo core) ..... ${outDarkTot}  (${pct(outDarkTot, remainTot)})`);
  console.log(`  outside mask, medium/near-ink ...... ${outHaloTot}  (${pct(outHaloTot, remainTot)})`);
  console.log(`  inside mask, still visible (resid) . ${inMaskVisTot}  (${pct(inMaskVisTot, remainTot)})`);

  console.log(`\n==== MASK-COVERAGE RECOVERY (dilate mask by r flat-grid px) ====`);
  console.log(`   r | recoverable | % of remaining | recov NEXT TO content | unique-content swept under mask`);
  for (const r of RADII)
    console.log(
      `${String(r).padStart(4)} | ${String(recov[r]).padStart(11)} | ${pct(recov[r], remainTot).padStart(14)} | ${String(recovNearContent[r]).padStart(21)} | ${contentSwept[r]}`,
    );
  console.log(
    `\nNotes: "recov NEXT TO content" = recovered px within 3px of a unique-content (flat-bright) pixel — the ONLY risk zone, must stay ~0.`,
  );
  console.log(`       "unique-content swept under mask" = diagram/formula/text px the grown mask now overlaps (PC still protects them via the flat-bright guard; this is structural-net erosion, informational).`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
