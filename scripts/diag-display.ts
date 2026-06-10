/* eslint-disable no-console */
/**
 * Visual proof of the display-only watermark cleanup. Renders the real PDF,
 * builds the SAME cross-page flat field the pipeline uses, crops the band that
 * contains the "cc-315 / 2-315" watermark (where Q103 starts on page 2), and
 * writes BEFORE and AFTER PNGs + a residual-watermark metric.
 *
 *   npx ts-node scripts/diag-display.ts "C:\path\to\paper.pdf" "C:\out\dir"
 */
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, buildWatermarkMask } from '../src/shared/ocr-engine/watermark-clean';
import { cleanCropForDisplay } from '../src/shared/ocr-engine/crop-display-clean';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

// Count "watermark-band" pixels: light grey (not near-white, not ink).
const grayBand = async (png: Buffer): Promise<{ band: number; total: number; pct: number }> => {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  let band = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] > 150 && data[i] < 245) band += 1;
  const total = info.width * info.height;
  return { band, total, pct: Math.round((band / total) * 1000) / 10 };
};

const main = async (): Promise<void> => {
  const file = process.argv[2];
  const outDir = process.argv[3] || path.dirname(file);
  const bytes = fs.readFileSync(file);
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(bytes, { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  const flat = await buildFlatField(pages);
  if (!flat) throw new Error('no flat field (need >=3 pages)');
  console.log(`flat field = ${flat.width}x${flat.height}`);
  const mask = buildWatermarkMask(flat);
  const maskPct = mask
    ? Math.round((mask.data.reduce((a, v) => a + (v ? 1 : 0), 0) / mask.data.length) * 1000) / 10
    : 0;
  console.log(`watermark mask = ${mask ? `${mask.width}x${mask.height}, ${maskPct}% of page flagged as LARGE watermark` : 'null'}`);

  // Region selectable via argv: pageIdx x0 y0 x1 y1. Default = page-2 cc-315 band.
  const pageIdx = Number(process.argv[4] ?? 2);
  // PRODUCTION-FAITHFUL: the displayed crop is taken from the RAW page (not the
  // flat-field-divided cleanPageImage). Cropping the "before" from the cleaned
  // page falsely inflates darkContentChanged because division already shifted pixels.
  const pageImage = pages[pageIdx - 1];
  const meta = await sharp(pageImage).metadata();
  const pageWidth = meta.width!;
  const pageHeight = meta.height!;
  const region = {
    x0: Number(process.argv[5] ?? 600),
    y0: Number(process.argv[6] ?? 560),
    x1: Number(process.argv[7] ?? 1120),
    y1: Number(process.argv[8] ?? 720),
  };
  const width = region.x1 - region.x0;
  const height = region.y1 - region.y0;

  const before = await sharp(pageImage)
    .extract({ left: region.x0, top: region.y0, width, height })
    .png()
    .toBuffer();
  const after = await cleanCropForDisplay(before, { flat, mask, region, pageWidth, pageHeight });
  // OLD behaviour (no page mask) for comparison — what production does today.
  const afterNoMask = await cleanCropForDisplay(before, { flat, region, pageWidth, pageHeight });
  {
    const gb = await sharp(before).greyscale().raw().toBuffer();
    const go = await sharp(afterNoMask).greyscale().raw().toBuffer();
    let ch = 0;
    let dch = 0;
    for (let i = 0; i < gb.length; i += 1)
      if (gb[i] !== go[i]) {
        ch += 1;
        if (gb[i] < 130) dch += 1;
      }
    console.log(`OLD (no mask): changed=${ch} darkContentChanged=${dch}  ← these pixels are what the mask now protects`);
  }

  const beforePath = path.join(outDir, 'crop-BEFORE.png');
  const afterPath = path.join(outDir, 'crop-AFTER.png');
  fs.writeFileSync(beforePath, before);
  fs.writeFileSync(afterPath, after);

  // Content-fidelity check: how many pixels changed, and — critically — how many
  // DARK (content) pixels changed. The latter MUST be 0 (no content modified).
  const gb = await sharp(before).greyscale().raw().toBuffer();
  const ga = await sharp(after).greyscale().raw().toBuffer();
  let changed = 0;
  let darkChanged = 0;
  let darkenedAny = 0; // any pixel made DARKER (should never happen — we only whiten)
  for (let i = 0; i < gb.length; i += 1) {
    if (gb[i] !== ga[i]) {
      changed += 1;
      if (gb[i] < 130) darkChanged += 1;
      if (ga[i] < gb[i]) darkenedAny += 1;
    }
  }
  console.log(
    `fidelity: changed=${changed} darkContentChanged=${darkChanged} (MUST be 0) darkenedAny=${darkenedAny} (MUST be 0)`,
  );

  const b = await grayBand(before);
  const a = await grayBand(after);
  console.log(`region = x[${region.x0}-${region.x1}] y[${region.y0}-${region.y1}] on page 2 (${pageWidth}x${pageHeight})`);
  console.log(`BEFORE: watermark-band pixels = ${b.band}/${b.total} (${b.pct}%)  → ${beforePath}`);
  console.log(`AFTER : watermark-band pixels = ${a.band}/${a.total} (${a.pct}%)  → ${afterPath}`);
  console.log(`reduction = ${Math.round((1 - a.band / Math.max(1, b.band)) * 100)}% of the grey watermark band removed`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
