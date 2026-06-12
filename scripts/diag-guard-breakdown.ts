/* eslint-disable no-console */
/**
 * GUARD-HIT BREAKDOWN for the watermark that SURVIVES display cleanup, on the real
 * RE NEET PST paper. Config mirrors what is enabled in production right now:
 *   OCR_DISPLAY_BG_TRAIL = true   (light trail removal on)
 *   OCR_DISPLAY_WM_PERSISTENT_CORE = off, OCR_DISPLAY_WM_MASK_CLOSE = 0  (defaults)
 *
 * "Watermark ink" set (content EXCLUDED by construction):
 *   persistent location  F < PROTECT_ABOVE (235)   — never white on any page
 *   visibly present      L < 235                    — ink is actually there this page
 *   NOT content-on-top   L >= F - KEEP_MARGIN (28)  — no extra darkness = the mark itself
 * This excludes every page-UNIQUE stroke (diagram/formula/graph/table → F bright) and
 * every content-drawn-over-watermark pixel. So the set is watermark + persistent chrome.
 *
 * Each surviving watermark pixel is attributed to the FIRST guard that keeps it, in the
 * exact order crop-display-clean.ts evaluates them:
 *   OUTSIDE_MASK   mreg < 128                       (mask gate — main pass skips it)
 *   DARK_CORE      inside mask, L<CORE_DARK or L<WHITE_FLOOR  (flat-BLIND dark guards C/F)
 *   CONTENT_HALO   inside mask, within HALO px of a dark core (C halo)
 *   REMOVED_MAIN   inside mask, whitened by the main pass
 *   REMOVED_BG     outside mask, whitened by Pass-2 trail removal
 * (E flat-bright and D darker-than-bg cannot fire inside the set — reported as a check.)
 *
 *   npx ts-node scripts/diag-guard-breakdown.ts "<pdf>" [outDir]
 */
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, buildWatermarkMask } from '../src/shared/ocr-engine/watermark-clean';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

// crop-display-clean.ts defaults.
const CORE_DARK = 115;
const HALO = 2;
const PROTECT_ABOVE = 235;
const KEEP_MARGIN = 28;
const WHITE_FLOOR = 120;
const BG_HARD_INK = 110;
const BG_HALO = 8;

const greyOf = async (png: Buffer): Promise<{ d: Uint8Array; w: number; h: number }> => {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { d: new Uint8Array(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
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

type Buckets = {
  footprint: number;
  outMask: number;
  darkCore: number;
  contentHalo: number;
  removedMain: number;
  removedBg: number;
  checkE: number;
  checkD: number;
};
const zero = (): Buckets => ({
  footprint: 0,
  outMask: 0,
  darkCore: 0,
  contentHalo: 0,
  removedMain: 0,
  removedBg: 0,
  checkE: 0,
  checkD: 0,
});

const main = async (): Promise<void> => {
  const file = process.argv[2];
  const outDir = process.argv[3] || path.join(path.dirname(file), 'guard-breakdown');
  if (!file) throw new Error('usage: diag-guard-breakdown.ts <pdf> [outDir]');
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
  console.log(
    `guards: CORE_DARK=${CORE_DARK} HALO=${HALO} WHITE_FLOOR=${WHITE_FLOOR} PROTECT_ABOVE=${PROTECT_ABOVE} KEEP_MARGIN=${KEEP_MARGIN} BG_HARD_INK=${BG_HARD_INK} BG_HALO=${BG_HALO}\n`,
  );
  console.log('page | wmFootprint | removed | OUTSIDE_MASK | DARK_CORE | CONTENT_HALO');

  const tot = zero();
  const overlayPages = new Set([12, 15, 18]); // a few for a visual guard map

  for (let i = 0; i < pages.length; i += 1) {
    const R = await greyOf(pages[i]);
    const { w: W, h: H } = R;
    const n = W * H;
    const fbuf = await sharp(Buffer.from(flat.data), {
      raw: { width: flat.width, height: flat.height, channels: 1 },
    })
      .resize(W, H, { fit: 'fill' })
      .toColourspace('b-w')
      .raw()
      .toBuffer();
    const F = new Uint8Array(fbuf.buffer, fbuf.byteOffset, fbuf.length);
    const mbuf = await sharp(Buffer.from(mask.data), {
      raw: { width: mask.width, height: mask.height, channels: 1 },
    })
      .resize(W, H, { fit: 'fill' })
      .toColourspace('b-w')
      .raw()
      .toBuffer();
    const M = new Uint8Array(mbuf.buffer, mbuf.byteOffset, mbuf.length);

    const core = new Uint8Array(n);
    const ink = new Uint8Array(n);
    for (let p = 0; p < n; p += 1) {
      if (R.d[p] < CORE_DARK) core[p] = 1;
      if (R.d[p] < BG_HARD_INK) ink[p] = 1;
    }
    const protectedSet = dilate(core, W, H, HALO);
    const inkRegion = dilate(ink, W, H, BG_HALO);

    const b = zero();
    const cat = new Uint8Array(n); // 0 none,1 outMask,2 darkCore,3 halo,4 remMain,5 remBg
    for (let p = 0; p < n; p += 1) {
      const L = R.d[p];
      const f = F[p];
      // watermark-ink set (content excluded)
      if (!(f < PROTECT_ABOVE && L < 235 && L >= f - KEEP_MARGIN)) continue;
      b.footprint += 1;
      const inMask = !(M[p] < 128);
      if (inMask) {
        if (f >= PROTECT_ABOVE) {
          b.checkE += 1;
          continue;
        } // can't happen (set), sanity
        if (L < f - KEEP_MARGIN) {
          b.checkD += 1;
          continue;
        } // can't happen (set), sanity
        if (protectedSet[p]) {
          if (core[p]) {
            b.darkCore += 1;
            cat[p] = 2;
          } else {
            b.contentHalo += 1;
            cat[p] = 3;
          }
        } else if (L < WHITE_FLOOR) {
          b.darkCore += 1;
          cat[p] = 2;
        } else {
          b.removedMain += 1;
          cat[p] = 4;
        }
      } else {
        // outside mask → Pass-2 trail removal (BG_TRAIL on): ink seed = L<BG_HARD_INK
        if (inkRegion[p]) {
          b.outMask += 1;
          cat[p] = 1;
        } else {
          b.removedBg += 1;
          cat[p] = 5;
        }
      }
    }
    const removed = b.removedMain + b.removedBg;
    const kept = b.outMask + b.darkCore + b.contentHalo;
    tot.footprint += b.footprint;
    tot.outMask += b.outMask;
    tot.darkCore += b.darkCore;
    tot.contentHalo += b.contentHalo;
    tot.removedMain += b.removedMain;
    tot.removedBg += b.removedBg;
    tot.checkE += b.checkE;
    tot.checkD += b.checkD;
    if (b.footprint > 0)
      console.log(
        `${String(i + 1).padStart(4)} | ${String(b.footprint).padStart(11)} | ${String(removed).padStart(7)} | ${String(b.outMask).padStart(12)} | ${String(b.darkCore).padStart(9)} | ${String(b.contentHalo).padStart(12)}  (kept=${kept})`,
      );

    if (overlayPages.has(i + 1)) {
      const ov = Buffer.alloc(n * 3);
      const COL: Record<number, [number, number, number]> = {
        1: [230, 30, 30], // outside mask = red
        2: [255, 140, 0], // dark-core guard = orange
        3: [240, 220, 0], // content halo = yellow
        4: [120, 120, 255], // removed main = blue
        5: [0, 200, 255], // removed bg = cyan
      };
      for (let p = 0; p < n; p += 1) {
        const c = cat[p];
        if (c && COL[c]) {
          ov[p * 3] = COL[c][0];
          ov[p * 3 + 1] = COL[c][1];
          ov[p * 3 + 2] = COL[c][2];
        } else {
          const g = R.d[p];
          ov[p * 3] = g;
          ov[p * 3 + 1] = g;
          ov[p * 3 + 2] = g;
        }
      }
      await sharp(ov, { raw: { width: W, height: H, channels: 3 } })
        .png()
        .toFile(path.join(outDir, `p${String(i + 1).padStart(2, '0')}-GUARDMAP.png`));
    }
  }

  const keptTot = tot.outMask + tot.darkCore + tot.contentHalo;
  const removedTot = tot.removedMain + tot.removedBg;
  const pct = (x: number, d: number) => (d ? `${Math.round((x / d) * 1000) / 10}%` : '0%');
  console.log(`\n==== TOTALS (${pages.length} pages) ====`);
  console.log(`watermark-ink footprint (content-excluded): ${tot.footprint}`);
  console.log(`  REMOVED already ........... ${removedTot}  (${pct(removedTot, tot.footprint)} of footprint)`);
  console.log(`     main mask pass ......... ${tot.removedMain}`);
  console.log(`     Pass-2 trail (BG_TRAIL)  ${tot.removedBg}`);
  console.log(`  STILL VISIBLE (kept) ...... ${keptTot}  (${pct(keptTot, tot.footprint)} of footprint)`);
  console.log(`\n  Of the REMAINING watermark (${keptTot} px), the guard preventing removal:`);
  console.log(`     OUTSIDE the page mask .... ${tot.outMask}  (${pct(tot.outMask, keptTot)})`);
  console.log(`     DARK-CORE guard (C/F) .... ${tot.darkCore}  (${pct(tot.darkCore, keptTot)})`);
  console.log(`     CONTENT-HALO guard ....... ${tot.contentHalo}  (${pct(tot.contentHalo, keptTot)})`);
  console.log(`\n  sanity (must be ~0): E flat-bright=${tot.checkE} D darker-than-bg=${tot.checkD}`);
  console.log(`  guard maps: ${outDir}\\p{12,15,18}-GUARDMAP.png  (red=outMask orange=darkCore yellow=halo)`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
