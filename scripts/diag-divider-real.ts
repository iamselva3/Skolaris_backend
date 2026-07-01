/* eslint-disable no-console */
/**
 * REAL full-PDF divider validation — renders a real multi-page PDF EXACTLY as production
 * (pdf-to-img scale 2), builds the real flat field, and measures whether the column divider
 * is actually removed by `removeColumnDivider` on the real page pixels.
 *
 * Usage: npx ts-node scripts/diag-divider-real.ts "C:\\path\\to\\file.pdf"
 */
import sharp from 'sharp';
import { removeColumnDivider } from '../src/shared/ocr-engine/crop-display-clean';
import { buildFlatField } from '../src/shared/ocr-engine/watermark-clean';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

/** Find the darkest near-full-height interior column (the most divider-like) and report its
 *  vertical ink coverage BEFORE vs AFTER cleaning — the production-truth metric. */
const profileDivider = async (label: string, buf: Buffer): Promise<void> => {
  const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width!;
  const H = info.height!;
  // dark = clearly below paper
  const dark = (x: number, y: number) => data[y * W + x] < 160;
  // longest vertical dark run per column, in the central half (interior, where a gutter divider lives)
  const lo = Math.round(W * 0.3);
  const hi = Math.round(W * 0.7);
  let bestX = -1;
  let bestRun = 0;
  let bestCover = 0;
  for (let x = lo; x < hi; x += 1) {
    let run = 0;
    let best = 0;
    let cover = 0;
    for (let y = 0; y < H; y += 1) {
      if (dark(x, y)) {
        run += 1;
        cover += 1;
        if (run > best) best = run;
      } else run = 0;
    }
    if (best > bestRun) {
      bestRun = best;
      bestX = x;
      bestCover = cover;
    }
  }
  console.log(
    `  [${label}] page ${W}x${H} · most divider-like interior column x=${bestX} ` +
      `longestDarkRun=${bestRun} (${((bestRun / H) * 100).toFixed(1)}% of height) coverage=${((bestCover / H) * 100).toFixed(1)}%`,
  );
};

const main = async () => {
  const file = process.argv[2];
  if (!file) throw new Error('pass a PDF path');
  const fs = await import('fs');
  const bytes = new Uint8Array(fs.readFileSync(file));
  const { pdf } = await esmImport('pdf-to-img');
  const doc = await pdf(bytes, { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  console.log(`Rendered ${pages.length} pages from ${file}`);

  const flat = await buildFlatField(pages);
  console.log(`Flat field: ${flat ? `${flat.width}x${flat.height}` : 'NULL (<3 pages)'}`);

  // Validate the first 3 pages (representative); compare BEFORE vs AFTER on each.
  const meta0 = await sharp(pages[0]).metadata();
  const pw = meta0.width ?? 0;
  const ph = meta0.height ?? 0;
  for (let i = 0; i < Math.min(3, pages.length); i += 1) {
    console.log(`\n=== PAGE ${i + 1} ===`);
    await profileDivider('BEFORE', pages[i]);
    const cleaned = await removeColumnDivider(pages[i], { flat, pageWidth: pw, pageHeight: ph });
    await profileDivider('AFTER ', cleaned);
    // Bounding box + count of changed pixels — must be a THIN vertical band, not content.
    const a = await sharp(pages[i]).greyscale().raw().toBuffer();
    const b = await sharp(cleaned).greyscale().raw().toBuffer();
    let cnt = 0;
    let minx = 1e9;
    let maxx = -1;
    let miny = 1e9;
    let maxy = -1;
    const Wp = (await sharp(pages[i]).metadata()).width!;
    for (let p = 0; p < a.length; p += 1)
      if (a[p] !== b[p]) {
        cnt += 1;
        const x = p % Wp;
        const y = (p / Wp) | 0;
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
    console.log(
      cnt
        ? `  CHANGED ${cnt}px · bbox x=[${minx}..${maxx}] (width ${maxx - minx + 1}) y=[${miny}..${maxy}] (height ${maxy - miny + 1})`
        : `  CHANGED 0px (no divider removed)`,
    );
  }
  console.log('\nWrote scripts/_divider_p*_before/after.png for visual check.');
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
