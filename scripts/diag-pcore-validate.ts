/* eslint-disable no-console */
/**
 * CONTENT-SAFETY + watermark-removal validation for OCR_DISPLAY_WM_PERSISTENT_CORE,
 * on the real RE NEET PST paper. Same harness shape as the BG_TRAIL validation.
 *
 *   baseline = current production-as-enabled : BG_TRAIL=on,  PERSISTENT_CORE=off
 *   test     = baseline + PERSISTENT_CORE=on
 * BG_TRAIL is ON in BOTH, so the diff isolates PERSISTENT_CORE's main-pass effect.
 *
 * persistentCore only whitens a pixel inside the mask where the flat field proves
 * persistence; it keeps unique content (E: F>=235) and content-over-watermark
 * (D: L<F-28). So a pixel it removes is CONTENT DAMAGE iff it violates one of those:
 *   flatBright  F >= PROTECT_ABOVE(235)   → unique content (diagram/formula/axis)  ALARM
 *   darkerBg    L <  F - KEEP_MARGIN(28)  → content drawn over the watermark        ALARM
 *   outMask     mreg < 128                → outside the large mask (PC must not act) ALARM
 *   safe        else                      → confirmed persistent watermark on no content
 *
 * Reports per-page + totals: additional watermark removed, remaining watermark, and
 * the three damage buckets (must be 0). Writes RAW/CURRENT/NEW/DIFF for affected
 * pages (DIFF: red = safe PC removal, GREEN = any content pixel removed = alarm).
 *
 *   npx ts-node scripts/diag-pcore-validate.ts "<pdf>" [outDir] [minDiffPx]
 */
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, buildWatermarkMask } from '../src/shared/ocr-engine/watermark-clean';
import { cleanCropForDisplay } from '../src/shared/ocr-engine/crop-display-clean';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

const PROTECT_ABOVE = Number(process.env.OCR_DISPLAY_WM_PROTECT_ABOVE ?? 235);
const KEEP_MARGIN = Number(process.env.OCR_DISPLAY_WM_KEEP_MARGIN ?? 28);

// Luma EXACTLY as crop-display-clean.ts computes it (0.299R+0.587G+0.114B on raw
// RGB) — NOT sharp.greyscale(), whose libvips colour conversion differs by ~1 level
// and would create false boundary hits in the L < F-28 classification.
const greyOf = async (png: Buffer): Promise<{ d: Uint8Array; w: number; h: number }> => {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  const d = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < w * h; p += 1, i += channels) {
    const r = data[i];
    const g = channels >= 3 ? data[i + 1] : r;
    const b = channels >= 3 ? data[i + 2] : r;
    d[p] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return { d, w, h };
};

const resampleTo = async (
  src: Uint8Array,
  sw: number,
  sh: number,
  w: number,
  h: number,
): Promise<Uint8Array> => {
  const b = await sharp(Buffer.from(src), { raw: { width: sw, height: sh, channels: 1 } })
    .resize(w, h, { fit: 'fill' })
    .toColourspace('b-w')
    .raw()
    .toBuffer();
  return new Uint8Array(b.buffer, b.byteOffset, b.length);
};

const main = async (): Promise<void> => {
  const file = process.argv[2];
  const outDir = process.argv[3] || path.join(path.dirname(file), 'pcore-evidence');
  const minDiff = Number(process.argv[4] ?? 30);
  if (!file) throw new Error('usage: diag-pcore-validate.ts <pdf> [outDir] [minDiffPx]');
  fs.mkdirSync(outDir, { recursive: true });

  const bytes = fs.readFileSync(file);
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(bytes, { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  const flat = await buildFlatField(pages);
  if (!flat) throw new Error('no flat field');
  const mask = buildWatermarkMask(flat);
  if (!mask) throw new Error('no mask');
  console.log(`pages=${pages.length} flat=${flat.width}x${flat.height}`);
  console.log(`baseline=BG_TRAIL:on PCORE:off   test=BG_TRAIL:on PCORE:on\n`);
  console.log('page | addRemoved | safe | flatBright | darkerBg | outMask | remainingWM');

  let tSafe = 0;
  let tBright = 0;
  let tDarker = 0;
  let tOut = 0;
  let tRemain = 0;
  let tFoot = 0;
  const affected: number[] = [];

  for (let i = 0; i < pages.length; i += 1) {
    const raw = pages[i];
    const meta = await sharp(raw).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (!W || !H) continue;
    const region = { x0: 0, y0: 0, x1: W, y1: H };
    const opts = { flat, mask, region, pageWidth: W, pageHeight: H };

    process.env.OCR_DISPLAY_BG_TRAIL = 'true';
    delete process.env.OCR_DISPLAY_WM_PERSISTENT_CORE;
    const base = await cleanCropForDisplay(raw, opts);
    process.env.OCR_DISPLAY_WM_PERSISTENT_CORE = 'true';
    const test = await cleanCropForDisplay(raw, opts);
    delete process.env.OCR_DISPLAY_WM_PERSISTENT_CORE;
    delete process.env.OCR_DISPLAY_BG_TRAIL;

    const R = await greyOf(raw);
    const B = await greyOf(base);
    const T = await greyOf(test);
    const n = W * H;
    const F = await resampleTo(flat.data, flat.width, flat.height, W, H);
    const M = await resampleTo(mask.data, mask.width, mask.height, W, H);

    let safe = 0;
    let bright = 0;
    let darker = 0;
    let out = 0;
    let remain = 0;
    let foot = 0;
    const diff = new Uint8Array(n); // 1 safe, 2 damage
    for (let p = 0; p < n; p += 1) {
      const L = R.d[p];
      const f = F[p];
      const isFootprint = f < PROTECT_ABOVE && L < 235 && L >= f - KEEP_MARGIN;
      if (isFootprint) foot += 1;
      // pixel newly whitened by PERSISTENT_CORE (white in test, not in baseline)
      if (T.d[p] >= 250 && B.d[p] < 250) {
        if (f >= PROTECT_ABOVE) {
          bright += 1;
          diff[p] = 2;
        } else if (L < f - KEEP_MARGIN) {
          darker += 1;
          diff[p] = 2;
        } else if (M[p] < 128) {
          out += 1;
          diff[p] = 2;
        } else {
          safe += 1;
          diff[p] = 1;
        }
      } else if (isFootprint && T.d[p] < 235) {
        remain += 1; // watermark ink still visible after PC
      }
    }
    const add = safe + bright + darker + out;
    tSafe += safe;
    tBright += bright;
    tDarker += darker;
    tOut += out;
    tRemain += remain;
    tFoot += foot;
    const flagPage = add >= minDiff;
    if (flagPage) affected.push(i + 1);
    if (add > 0)
      console.log(
        `${String(i + 1).padStart(4)} | ${String(add).padStart(10)} | ${String(safe).padStart(4)} | ${String(bright).padStart(10)} | ${String(darker).padStart(8)} | ${String(out).padStart(7)} | ${String(remain).padStart(11)}${flagPage ? '  <=' : ''}`,
      );

    if (flagPage) {
      const tag = `p${String(i + 1).padStart(2, '0')}`;
      await sharp(raw).png().toFile(path.join(outDir, `${tag}-RAW.png`));
      await sharp(base).png().toFile(path.join(outDir, `${tag}-CURRENT.png`));
      await sharp(test).png().toFile(path.join(outDir, `${tag}-NEW.png`));
      const ov = Buffer.alloc(n * 3);
      for (let p = 0; p < n; p += 1) {
        if (diff[p] === 1) {
          ov[p * 3] = 230;
          ov[p * 3 + 1] = 30;
          ov[p * 3 + 2] = 30;
        } else if (diff[p] === 2) {
          ov[p * 3] = 0;
          ov[p * 3 + 1] = 255;
          ov[p * 3 + 2] = 0;
        } else {
          const g = R.d[p];
          ov[p * 3] = g;
          ov[p * 3 + 1] = g;
          ov[p * 3 + 2] = g;
        }
      }
      await sharp(ov, { raw: { width: W, height: H, channels: 3 } })
        .png()
        .toFile(path.join(outDir, `${tag}-DIFF.png`));
    }
  }

  const add = tSafe + tBright + tDarker + tOut;
  console.log(`\n==== TOTALS (${pages.length} pages) ====`);
  console.log(`watermark-ink footprint (content-excluded): ${tFoot}`);
  console.log(`ADDITIONAL watermark removed by PERSISTENT_CORE: ${add}`);
  console.log(`  safe (confirmed persistent watermark) .. ${tSafe}`);
  console.log(`  flat-bright (unique content) ........... ${tBright}   ${tBright ? '*** ALARM ***' : 'OK (0)'}`);
  console.log(`  darker-than-bg (content over wm) ....... ${tDarker}   ${tDarker ? '*** ALARM ***' : 'OK (0)'}`);
  console.log(`  outside mask (PC must not act) ......... ${tOut}   ${tOut ? '*** ALARM ***' : 'OK (0)'}`);
  console.log(`REMAINING watermark ink still visible after PC: ${tRemain}`);
  console.log(`affected pages (>=${minDiff}px): [${affected.join(', ')}]`);
  console.log(`images: ${outDir}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
