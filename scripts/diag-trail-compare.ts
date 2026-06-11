/* eslint-disable no-console */
/**
 * EVIDENCE for OCR_DISPLAY_BG_TRAIL on the real RE NEET PST paper.
 *
 * For every page it renders the page, builds the SAME cross-page flat field + large
 * watermark mask the pipeline uses, and runs the REAL display cleanup twice over the
 * whole page as the crop region:
 *   CURRENT = production defaults (BG_TRAIL off)
 *   NEW     = OCR_DISPLAY_BG_TRAIL=true   (everything else default)
 * Nothing else changes, so the diff is attributable to the flag alone.
 *
 * It then classifies EVERY pixel that NEW whitens but CURRENT keeps:
 *   darkInk  = was dark ink in RAW (luma < BG_HARD_INK)            → CONTENT DAMAGE (must be 0)
 *   halo     = within BG_HALO px of dark ink                        → near content (must be 0)
 *   bright   = flat-bright (unique-content location)                → content (must be 0)
 *   bg       = persistent grey, no ink/unique nearby                → safe background trail
 * By the algorithm darkInk/halo/bright should all be 0; measuring them on the actual
 * paper IS the proof. For "affected" pages it writes RAW / CURRENT / NEW / DIFF PNGs
 * (DIFF: red = safely removed bg trail, GREEN = any content pixel removed = alarm).
 *
 *   npx ts-node scripts/diag-trail-compare.ts "C:\path\RE NEET PST 3 (1).pdf" "C:\out" [minDiffPx]
 */
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, buildWatermarkMask } from '../src/shared/ocr-engine/watermark-clean';
import { cleanCropForDisplay } from '../src/shared/ocr-engine/crop-display-clean';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

const BG_HARD_INK = Number(process.env.OCR_DISPLAY_BG_HARD_INK ?? 110);
const BG_HALO = Number(process.env.OCR_DISPLAY_BG_HALO ?? 8);
const PROTECT_ABOVE = Number(process.env.OCR_DISPLAY_WM_PROTECT_ABOVE ?? 235);

const grey = async (png: Buffer): Promise<{ d: Uint8Array; w: number; h: number }> => {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { d: new Uint8Array(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
};

// Chebyshev dilation (separable) — mirrors crop-display-clean's halo.
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
  const outDir = process.argv[3] || path.join(path.dirname(file), 'trail-evidence');
  const minDiff = Number(process.argv[4] ?? 30);
  if (!file) throw new Error('usage: diag-trail-compare.ts <pdf> <outDir> [minDiffPx]');
  fs.mkdirSync(outDir, { recursive: true });

  const bytes = fs.readFileSync(file);
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(bytes, { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  console.log(`pages=${pages.length}`);

  const flat = await buildFlatField(pages);
  if (!flat) throw new Error('no flat field (need >=3 pages)');
  const mask = buildWatermarkMask(flat);
  console.log(`flat=${flat.width}x${flat.height} mask=${mask ? `${mask.width}x${mask.height}` : 'null'}`);
  console.log(`classify thresholds: BG_HARD_INK=${BG_HARD_INK} BG_HALO=${BG_HALO} PROTECT_ABOVE=${PROTECT_ABOVE}\n`);

  let totBg = 0;
  let totDark = 0;
  let totHalo = 0;
  let totBright = 0;
  const affected: number[] = [];
  console.log('page | newlyWhitened |  bg  | darkInk | halo | bright   (darkInk/halo/bright MUST be 0)');

  for (let i = 0; i < pages.length; i += 1) {
    const raw = pages[i];
    const meta = await sharp(raw).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (!W || !H) continue;
    const region = { x0: 0, y0: 0, x1: W, y1: H };
    const opts = { flat, mask, region, pageWidth: W, pageHeight: H };

    delete process.env.OCR_DISPLAY_BG_TRAIL;
    const cur = await cleanCropForDisplay(raw, opts);
    process.env.OCR_DISPLAY_BG_TRAIL = 'true';
    const nw = await cleanCropForDisplay(raw, opts);
    delete process.env.OCR_DISPLAY_BG_TRAIL;

    const R = await grey(raw);
    const C = await grey(cur);
    const N = await grey(nw);
    const n = W * H;

    // flat resampled to page (single channel) for the bright-location test.
    const fbuf = await sharp(Buffer.from(flat.data), {
      raw: { width: flat.width, height: flat.height, channels: 1 },
    })
      .resize(W, H, { fit: 'fill' })
      .toColourspace('b-w')
      .raw()
      .toBuffer();
    const F = new Uint8Array(fbuf.buffer, fbuf.byteOffset, fbuf.length);

    const darkInk = new Uint8Array(n);
    for (let p = 0; p < n; p += 1) if (R.d[p] < BG_HARD_INK) darkInk[p] = 1;
    const inkHalo = dilate(darkInk, W, H, BG_HALO);

    let bg = 0;
    let dark = 0;
    let halo = 0;
    let bright = 0;
    const diff = new Uint8Array(n); // 1 = safe bg, 2 = content (alarm)
    for (let p = 0; p < n; p += 1) {
      if (!(N.d[p] >= 250 && C.d[p] < 250)) continue; // newly whitened by NEW only
      if (darkInk[p]) {
        dark += 1;
        diff[p] = 2;
      } else if (F[p] >= PROTECT_ABOVE) {
        bright += 1;
        diff[p] = 2;
      } else if (inkHalo[p]) {
        halo += 1;
        diff[p] = 2;
      } else {
        bg += 1;
        diff[p] = 1;
      }
    }
    const newly = bg + dark + halo + bright;
    totBg += bg;
    totDark += dark;
    totHalo += halo;
    totBright += bright;
    const flagPage = newly >= minDiff;
    if (flagPage) affected.push(i + 1);
    if (newly > 0)
      console.log(
        `${String(i + 1).padStart(4)} | ${String(newly).padStart(13)} | ${String(bg).padStart(4)} | ${String(dark).padStart(7)} | ${String(halo).padStart(4)} | ${String(bright).padStart(6)}${flagPage ? '   <= affected' : ''}`,
      );

    if (flagPage) {
      const tag = `p${String(i + 1).padStart(2, '0')}`;
      await sharp(raw).png().toFile(path.join(outDir, `${tag}-RAW.png`));
      await sharp(cur).png().toFile(path.join(outDir, `${tag}-CURRENT.png`));
      await sharp(nw).png().toFile(path.join(outDir, `${tag}-NEW.png`));
      // DIFF overlay: RAW in grey, removed-bg = red, removed-content = bright green.
      const ov = Buffer.alloc(n * 3);
      for (let p = 0; p < n; p += 1) {
        const g = R.d[p];
        if (diff[p] === 1) {
          ov[p * 3] = 230;
          ov[p * 3 + 1] = 30;
          ov[p * 3 + 2] = 30;
        } else if (diff[p] === 2) {
          ov[p * 3] = 0;
          ov[p * 3 + 1] = 255;
          ov[p * 3 + 2] = 0;
        } else {
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

  console.log(`\n==== TOTALS across ${pages.length} pages ====`);
  console.log(`newly whitened by BG_TRAIL: ${totBg + totDark + totHalo + totBright}`);
  console.log(`  safe background ............ ${totBg}`);
  console.log(`  dark-ink (CONTENT DAMAGE) .. ${totDark}   ${totDark ? '*** ALARM ***' : 'OK (0)'}`);
  console.log(`  ink halo (near content) .... ${totHalo}   ${totHalo ? '*** ALARM ***' : 'OK (0)'}`);
  console.log(`  flat-bright (unique content) ${totBright}   ${totBright ? '*** ALARM ***' : 'OK (0)'}`);
  console.log(`affected pages (>= ${minDiff}px): [${affected.join(', ')}]`);
  console.log(`images written to: ${outDir}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
