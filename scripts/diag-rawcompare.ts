/* eslint-disable no-console */
/**
 * Is dark CONTENT ever removed by the pipeline? Compares, for a region:
 *   RAW (pdf render, no processing)
 *   → PRE-OCR cleanPageImage (flat-field division, feeds OCR + the crop)
 *   → DISPLAY cleanCropForDisplay (the review-image pass)
 * Reports how many DARK (content) pixels present in RAW became light at each stage.
 * Dark-content loss MUST be ~0 at every stage.
 *
 *   npx ts-node scripts/diag-rawcompare.ts "<pdf>" <pageIdx> <x0> <y0> <x1> <y1>
 */
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { cleanCropForDisplay } from '../src/shared/ocr-engine/crop-display-clean';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

const cropOf = (img: Buffer, r: { x0: number; y0: number; x1: number; y1: number }): Promise<Buffer> =>
  sharp(img).extract({ left: r.x0, top: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0 }).png().toBuffer();

const gray = async (png: Buffer): Promise<Buffer> =>
  (await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true })).data;

// dark content pixels in `base` (luma < DARK) that became light (> LIGHT) in `cmp`.
const lostDark = async (base: Buffer, cmp: Buffer): Promise<{ darkTotal: number; lost: number }> => {
  const a = await gray(base);
  const b = await gray(cmp);
  let darkTotal = 0;
  let lost = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] < 130) {
      darkTotal += 1;
      if (b[i] > 200) lost += 1;
    }
  }
  return { darkTotal, lost };
};

const main = async (): Promise<void> => {
  const file = process.argv[2];
  const pageIdx = Number(process.argv[3] ?? 1);
  const region = {
    x0: Number(process.argv[4] ?? 20),
    y0: Number(process.argv[5] ?? 85),
    x1: Number(process.argv[6] ?? 620),
    y1: Number(process.argv[7] ?? 1150),
  };
  const out = path.dirname(file);
  const bytes = fs.readFileSync(file);
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(bytes, { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);

  const raw = pages[pageIdx - 1];
  const flat = await buildFlatField(pages);
  const meta = await sharp(raw).metadata();
  const cleaned = await cleanPageImage(raw, flat); // PRE-OCR stage (feeds OCR + crop)

  const rawCrop = await cropOf(raw, region);
  const cleanedCrop = await cropOf(cleaned, region);
  const displayCrop = await cleanCropForDisplay(cleanedCrop, {
    flat,
    region,
    pageWidth: meta.width!,
    pageHeight: meta.height!,
  });

  fs.writeFileSync(path.join(out, 'cmp-RAW.png'), rawCrop);
  fs.writeFileSync(path.join(out, 'cmp-PREOCR.png'), cleanedCrop);
  fs.writeFileSync(path.join(out, 'cmp-DISPLAY.png'), displayCrop);

  // The FIX candidate: crop the display image from RAW, clean for display.
  const displayFromRaw = await cleanCropForDisplay(rawCrop, {
    flat,
    region,
    pageWidth: meta.width!,
    pageHeight: meta.height!,
  });
  fs.writeFileSync(path.join(out, 'cmp-DISPLAY-FROM-RAW.png'), displayFromRaw);

  const s1 = await lostDark(rawCrop, cleanedCrop);
  const s2 = await lostDark(rawCrop, displayCrop);
  const s3 = await lostDark(rawCrop, displayFromRaw);
  const pct = (x: number): string => `${((x / Math.max(1, s1.darkTotal)) * 100).toFixed(2)}%`;
  console.log(`region x[${region.x0}-${region.x1}] y[${region.y0}-${region.y1}] page ${pageIdx}`);
  console.log(`dark content pixels in RAW: ${s1.darkTotal}`);
  console.log(`  lost by PRE-OCR cleanPageImage       : ${s1.lost}  (${pct(s1.lost)})  → cmp-PREOCR.png`);
  console.log(`  lost by cleaned→DISPLAY (current)    : ${s2.lost}  (${pct(s2.lost)})  → cmp-DISPLAY.png`);
  console.log(`  lost by RAW→DISPLAY (the fix)        : ${s3.lost}  (${pct(s3.lost)})  → cmp-DISPLAY-FROM-RAW.png`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
