/* eslint-disable no-console */
/**
 * WHY is the large diagonal watermark not entering the page-level mask?
 * Runs the REAL detector (analyzeWatermarkMask) on one page and dumps:
 *   - flat-field + threshold config
 *   - every connected component: bbox, area, candArea, span, flat intensity
 *     (mean/min/max), accepted?, and the reason
 *   - which components were accepted into the final mask
 *   - a "watermark probe": at points the user marks as watermark, compare the
 *     RAW page luma (is a watermark visibly there?) vs the FLAT-FIELD luma (did
 *     cross-page consensus capture it, or wash it to white?). This is the test
 *     for "watermark not pixel-stable across pages".
 * And writes visualizations:
 *   diag-RAW.png            the page
 *   diag-FLAT.png           the cross-page flat field (what the detector sees)
 *   diag-CANDIDATE.png      persistent-grey candidate mask
 *   diag-LARGE.png          large-component (final) mask
 *   diag-WHITENED.png       pixels cleanCropForDisplay would actually whiten
 *
 *   npx ts-node scripts/diag-mask.ts "<pdf>" <pageIdx> [outDir]
 */
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildFlatField,
  analyzeWatermarkMask,
  buildWatermarkMask,
  type FlatField,
} from '../src/shared/ocr-engine/watermark-clean';
import { cleanCropForDisplay } from '../src/shared/ocr-engine/crop-display-clean';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

/** Upscale a low-res 0/1 (or 0..255) field to page size as a crisp B/W PNG.
 *  `invert` shows set pixels as BLACK on white (easier to read as a mask). */
const fieldToPng = async (
  data: Uint8Array,
  w: number,
  h: number,
  pageW: number,
  pageH: number,
  scaleTo255: boolean,
  invert: boolean,
): Promise<Buffer> => {
  const buf = Buffer.alloc(w * h);
  for (let i = 0; i < buf.length; i += 1) {
    let v = scaleTo255 ? (data[i] ? 255 : 0) : data[i];
    if (invert) v = 255 - v;
    buf[i] = v;
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 1 } })
    .resize(pageW, pageH, { fit: 'fill', kernel: 'nearest' })
    .png()
    .toBuffer();
};

const flatLumaAt = (flat: FlatField, px: number, py: number, pageW: number, pageH: number): number => {
  const fx = Math.min(flat.width - 1, Math.floor((px / pageW) * flat.width));
  const fy = Math.min(flat.height - 1, Math.floor((py / pageH) * flat.height));
  return flat.data[fy * flat.width + fx];
};

const main = async (): Promise<void> => {
  const file = process.argv[2];
  const pageIdx = Number(process.argv[3] ?? 1);
  const outDir = process.argv[4] || path.dirname(file);
  if (!file || !fs.existsSync(file)) throw new Error(`PDF not found: ${file}`);

  const bytes = fs.readFileSync(file);
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(bytes, { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  console.log(`pages=${pages.length}`);

  const flat = await buildFlatField(pages);
  if (!flat) throw new Error('no flat field (need >=3 pages / disabled)');
  const raw = pages[pageIdx - 1];
  const meta = await sharp(raw).metadata();
  const pageW = meta.width!;
  const pageH = meta.height!;

  const an = analyzeWatermarkMask(flat)!;
  console.log(`\n==== FLAT FIELD ${flat.width}x${flat.height} · page ${pageIdx} ${pageW}x${pageH} ====`);
  console.log(
    `thresholds: greyFloor=${an.greyFloor} brightCeil=${an.brightCeil} dilate=${an.dilate} ` +
      `close=${an.close} minSpan=${an.minSpan}px minArea=${an.minArea}px · ` +
      `persistentCore=${process.env.OCR_DISPLAY_WM_PERSISTENT_CORE === 'true' ? 'ON' : 'off'}`,
  );
  const candCount = an.candidate.reduce((a, v) => a + v, 0);
  const maskCount = an.mask.reduce((a, v) => a + v, 0);
  console.log(
    `candidate grey pixels=${candCount} (${((candCount / (flat.width * flat.height)) * 100).toFixed(1)}%) ` +
      `· final mask pixels=${maskCount} (${((maskCount / (flat.width * flat.height)) * 100).toFixed(1)}%)`,
  );

  // Flat-field global histogram buckets — is the watermark even IN the flat field?
  const buckets = [0, 0, 0, 0, 0]; // <90, 90-110, 110-200, 200-238, >=238
  for (const v of flat.data) {
    if (v < 90) buckets[0] += 1;
    else if (v < an.greyFloor) buckets[1] += 1;
    else if (v < 200) buckets[2] += 1;
    else if (v < an.brightCeil) buckets[3] += 1;
    else buckets[4] += 1;
  }
  const tot = flat.data.length;
  const pc = (n: number) => `${((n / tot) * 100).toFixed(1)}%`;
  console.log(
    `flat luma histogram: <90(dark)=${pc(buckets[0])} 90-${an.greyFloor}=${pc(buckets[1])} ` +
      `${an.greyFloor}-200(grey✓)=${pc(buckets[2])} 200-${an.brightCeil}(grey✓)=${pc(buckets[3])} ` +
      `>=${an.brightCeil}(white)=${pc(buckets[4])}`,
  );

  console.log(`\n==== COMPONENTS: ${an.components.length} total ====`);
  const sorted = [...an.components].sort((a, b) => b.area - a.area);
  console.log(`top components by area (bbox in flat-grid px):`);
  for (const c of sorted.slice(0, 20)) {
    console.log(
      `  #${c.id} bbox=[${c.x0},${c.y0}-${c.x1},${c.y1}] span=${c.span} area=${c.area} cand=${c.candArea} ` +
        `flat(mean/min/max)=${c.flatMean}/${c.flatMin}/${c.flatMax} → ${c.accepted ? 'ACCEPT' : 'reject'} (${c.reason})`,
    );
  }
  const accepted = an.components.filter((c) => c.accepted);
  console.log(`\nACCEPTED into final mask: ${accepted.length} component(s): [${accepted.map((c) => `#${c.id}`).join(', ')}]`);
  console.log(`largest REJECTED: ${
    sorted.filter((c) => !c.accepted).slice(0, 5).map((c) => `#${c.id}(area${c.area},span${c.span})`).join(', ') || 'none'
  }`);

  // Watermark probe points (flat-grid fraction → page px). Tweak via argv if needed.
  console.log(`\n==== WATERMARK PROBE (RAW grey present? vs FLAT captured?) ====`);
  const rawGray = await sharp(raw).greyscale().raw().toBuffer();
  const probes: Array<[string, number, number]> = [
    ['center', Math.round(pageW * 0.5), Math.round(pageH * 0.5)],
    ['lower-left diag', Math.round(pageW * 0.25), Math.round(pageH * 0.8)],
    ['mid-left diag', Math.round(pageW * 0.2), Math.round(pageH * 0.6)],
    ['lower-center', Math.round(pageW * 0.45), Math.round(pageH * 0.85)],
  ];
  for (const [name, px, py] of probes) {
    const rl = rawGray[py * pageW + px];
    const fl = flatLumaAt(flat, px, py, pageW, pageH);
    const verdict =
      rl < 235 && fl >= an.brightCeil
        ? 'WATERMARK IN RAW but FLAT washed it to white → NOT pixel-stable across pages → excluded'
        : rl < 235 && fl < an.greyFloor
          ? 'grey in raw AND flat dark → below greyFloor → excluded as "dark structure"'
          : rl < 235 && fl >= an.greyFloor && fl < an.brightCeil
            ? 'grey in raw AND flat grey → IS a candidate'
            : 'raw ~white here (no watermark at this point)';
    console.log(`  ${name} @(${px},${py}): rawLuma=${rl} flatLuma=${fl} → ${verdict}`);
  }

  // Visualizations
  fs.writeFileSync(path.join(outDir, 'diag-RAW.png'), await sharp(raw).png().toBuffer());
  fs.writeFileSync(path.join(outDir, 'diag-FLAT.png'), await fieldToPng(flat.data, flat.width, flat.height, pageW, pageH, false, false));
  fs.writeFileSync(path.join(outDir, 'diag-CANDIDATE.png'), await fieldToPng(an.candidate, flat.width, flat.height, pageW, pageH, true, true));
  fs.writeFileSync(path.join(outDir, 'diag-LARGE.png'), await fieldToPng(an.mask, flat.width, flat.height, pageW, pageH, true, true));

  // What cleanCropForDisplay would ACTUALLY whiten on the whole page (real logic).
  const mask = buildWatermarkMask(flat);
  const region = { x0: 0, y0: 0, x1: pageW, y1: pageH };
  const cleaned = await cleanCropForDisplay(await sharp(raw).png().toBuffer(), {
    flat,
    mask,
    region,
    pageWidth: pageW,
    pageHeight: pageH,
  });
  const cg = await sharp(cleaned).greyscale().raw().toBuffer();
  const wmap = Buffer.alloc(pageW * pageH, 255);
  let whitened = 0;
  for (let i = 0; i < cg.length; i += 1)
    if (rawGray[i] < 240 && cg[i] >= 250) {
      wmap[i] = 0;
      whitened += 1;
    }
  fs.writeFileSync(
    path.join(outDir, 'diag-WHITENED.png'),
    await sharp(wmap, { raw: { width: pageW, height: pageH, channels: 1 } }).png().toBuffer(),
  );
  fs.writeFileSync(path.join(outDir, 'diag-AFTER.png'), cleaned);
  console.log(`\nactually whitened on page: ${whitened} px (black in diag-WHITENED.png; cleaned page → diag-AFTER.png)`);

  // ---- GUARD BREAKDOWN over masked, visible-watermark pixels ----
  // Replicates crop-display-clean.ts constants + decision, to show WHICH guard
  // keeps the watermark. Restricted to the user-marked watermark region (argv
  // 5..8, default = centre band where the Aakash logo sits).
  const CORE_DARK = Number(process.env.OCR_DISPLAY_WM_CORE ?? 115);
  const PROTECT_ABOVE = Number(process.env.OCR_DISPLAY_WM_PROTECT_ABOVE ?? 235);
  const KEEP_MARGIN = Number(process.env.OCR_DISPLAY_WM_KEEP_MARGIN ?? 28);
  const WHITE_FLOOR = Number(process.env.OCR_DISPLAY_WM_WHITE_FLOOR ?? 120);
  const rx0 = Number(process.argv[5] ?? Math.round(pageW * 0.38));
  const ry0 = Number(process.argv[6] ?? Math.round(pageH * 0.42));
  const rx1 = Number(process.argv[7] ?? Math.round(pageW * 0.72));
  const ry1 = Number(process.argv[8] ?? Math.round(pageH * 0.66));
  // upscale flat + mask to page size for 1:1 comparison
  const flatPage = await sharp(Buffer.from(flat.data), { raw: { width: flat.width, height: flat.height, channels: 1 } })
    .resize(pageW, pageH, { fit: 'fill' })
    .raw()
    .toBuffer();
  const maskPage = await sharp(Buffer.from(mask!.data.map((v) => (v ? 255 : 0))), {
    raw: { width: mask!.width, height: mask!.height, channels: 1 },
  })
    .resize(pageW, pageH, { fit: 'fill' })
    .raw()
    .toBuffer();
  const cnt = { visible: 0, notInMask: 0, core: 0, flatBright: 0, floor: 0, margin: 0, whiten: 0 };
  const ex: string[] = [];
  for (let y = ry0; y < ry1; y += 1)
    for (let x = rx0; x < rx1; x += 1) {
      const i = y * pageW + x;
      const L = rawGray[i];
      if (L >= 235) continue; // ~white = no watermark ink here
      cnt.visible += 1;
      const F = flatPage[i];
      if (maskPage[i] < 128) {
        cnt.notInMask += 1;
        continue;
      }
      if (L < CORE_DARK) cnt.core += 1;
      else if (F >= PROTECT_ABOVE) cnt.flatBright += 1;
      else if (L < WHITE_FLOOR) cnt.floor += 1;
      else if (L < F - KEEP_MARGIN) cnt.margin += 1;
      else {
        cnt.whiten += 1;
        if (ex.length < 6) ex.push(`(${x},${y}) L=${L} F=${F}`);
      }
    }
  console.log(`\n==== GUARD BREAKDOWN in watermark region x[${rx0}-${rx1}] y[${ry0}-${ry1}] ====`);
  console.log(`visible ink pixels (rawLuma<235): ${cnt.visible}`);
  console.log(`  kept — outside mask (A)         : ${cnt.notInMask}`);
  console.log(`  kept — dark core <${CORE_DARK} (C)        : ${cnt.core}`);
  console.log(`  kept — flat bright >=${PROTECT_ABOVE} (E)    : ${cnt.flatBright}`);
  console.log(`  kept — below floor <${WHITE_FLOOR} (F)       : ${cnt.floor}`);
  console.log(`  kept — darker than bg by ${KEEP_MARGIN} (D)  : ${cnt.margin}   ← L < F-${KEEP_MARGIN}`);
  console.log(`  WHITENED                        : ${cnt.whiten}  e.g. ${ex.join('  ')}`);

  console.log(`\nwrote: diag-RAW / diag-FLAT / diag-CANDIDATE / diag-LARGE / diag-WHITENED .png → ${outDir}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
