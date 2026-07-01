/* eslint-disable no-console */
/**
 * WHY the naive bounding-box trim leaves huge whitespace, and what a content-DENSITY
 * block trim recovers. For each real display crop it computes:
 *   NAIVE bbox  = extent of ANY non-white pixel (luma < 240) — what the first analysis used.
 *   BLOCK bbox  = the dense CONTENT block at the top, ignoring sparse trailing chrome
 *                 (footer separator rules, page numbers, CC-315 watermark codes, the
 *                 full-height column divider). Trailing dark pixels separated from the
 *                 content by a large vertical gap are EXCLUDED.
 * It reports how often the naive bbox is dragged to the bottom by trailing chrome, and
 * how much more the block trim recovers. Saves BEFORE / NAIVE / BLOCK PNGs for the
 * crops where they differ most (the user's Q176/Q180 class).
 *
 *   npx ts-node scripts/diag-crop-content-block.ts "<pdf>" [outDir]
 */
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { segmentVisualDrafts } from '../src/shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

const WHITE = 240; // naive: luma >= WHITE ⇒ background
const CONTENT_DARK = Number(process.env.TRIM_CONTENT_DARK ?? 150); // block: real ink is darker than CC-315 grey
const PAD = Number(process.env.TRIM_PAD ?? 14);

const collectWordBoxes = (data: any): OcrWordBox[] => {
  const out: OcrWordBox[] = [];
  for (const b of data?.blocks ?? [])
    for (const p of b.paragraphs ?? [])
      for (const l of p.lines ?? [])
        for (const w of l.words ?? []) {
          const t = (w.text ?? '').trim();
          if (!t || !w.bbox) continue;
          const { x0, y0, x1, y1 } = w.bbox;
          if ([x0, y0, x1, y1].some((v) => typeof v !== 'number')) continue;
          out.push({ text: t, x0, y0, x1, y1 });
        }
  return out;
};

interface Box { x0: number; y0: number; x1: number; y1: number; }
const area = (b: Box) => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
const pad = (b: Box, w: number, h: number, p: number): Box => ({
  x0: Math.max(0, b.x0 - p), y0: Math.max(0, b.y0 - p),
  x1: Math.min(w - 1, b.x1 + p), y1: Math.min(h - 1, b.y1 + p),
});

const analyse = async (png: Buffer): Promise<{ w: number; h: number; naive: Box | null; block: Box | null } | null> => {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;

  // NAIVE: any non-white pixel.
  let nx0 = w, ny0 = h, nx1 = -1, ny1 = -1;
  // per-row dark-ink count (for the block pass).
  const rowDark = new Int32Array(h);
  const colDark = new Int32Array(w);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const v = data[y * w + x];
      if (v < WHITE) { if (x < nx0) nx0 = x; if (x > nx1) nx1 = x; if (y < ny0) ny0 = y; if (y > ny1) ny1 = y; }
      if (v < CONTENT_DARK) { rowDark[y] += 1; colDark[x] += 1; }
    }
  const naive: Box | null = nx1 < 0 ? null : { x0: nx0, y0: ny0, x1: nx1, y1: ny1 };

  // BLOCK: dense content rows = >= rowThresh dark-ink pixels. Walk down from the first
  // content row; stop when a gap of non-content rows exceeds blockGap (the big blank
  // band before the footer chrome). Trailing rules/page-numbers/codes are excluded.
  const rowThresh = Math.max(2, Math.round(0.008 * w));
  const blockGap = Math.max(8, Math.round(0.06 * h));
  let firstContent = -1;
  for (let y = 0; y < h; y += 1) if (rowDark[y] >= rowThresh) { firstContent = y; break; }
  let block: Box | null = null;
  if (firstContent >= 0) {
    let bottom = firstContent, gap = 0;
    for (let y = firstContent; y < h; y += 1) {
      if (rowDark[y] >= rowThresh) { bottom = y; gap = 0; }
      else { gap += 1; if (gap > blockGap) break; }
    }
    // content columns WITHIN the block rows (recompute to exclude the divider far from text).
    const colInBlock = new Int32Array(w);
    for (let y = firstContent; y <= bottom; y += 1)
      for (let x = 0; x < w; x += 1) if (data[y * w + x] < CONTENT_DARK) colInBlock[x] += 1;
    const colThresh = Math.max(2, Math.round(0.01 * (bottom - firstContent + 1)));
    let left = -1, right = -1;
    for (let x = 0; x < w; x += 1) if (colInBlock[x] >= colThresh) { left = x; break; }
    for (let x = w - 1; x >= 0; x -= 1) if (colInBlock[x] >= colThresh) { right = x; break; }
    // drop a lone full-height divider column hugging the right edge, isolated by a gap.
    if (left >= 0 && right >= left) block = { x0: left, y0: firstContent, x1: right, y1: bottom };
  }
  return { w, h, naive, block };
};

const main = async (): Promise<void> => {
  const file = process.argv[2];
  const outDir = process.argv[3] || path.join(path.dirname(file), 'crop-block');
  fs.mkdirSync(outDir, { recursive: true });
  const bytes = fs.readFileSync(file);
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(bytes, { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  const flat = await buildFlatField(pages);
  const mask = buildWatermarkMask(flat);
  const worker = await createWorker('eng');
  const crops: Buffer[] = [];
  const putObject = async (_k: string, body: Buffer): Promise<void> => { crops.push(body); };
  let offset = 0;
  for (let i = 0; i < pages.length; i += 1) {
    const clean = await cleanPageImage(pages[i], flat);
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    const { drafts } = await segmentVisualDrafts(clean, collectWordBoxes(data), i + 1, {
      putObject, figureKeyPrefix: 'diag', positionOffset: offset, displayFlat: flat, displayMask: mask, displaySource: pages[i],
    } as any);
    offset += drafts.length;
    process.stdout.write(`\rpage ${i + 1}/${pages.length} crops=${crops.length}`);
  }
  await worker.terminate();
  console.log('\n');

  let sumNaive = 0, sumBlock = 0, n = 0, draggedToBottom = 0;
  const rows: Array<{ i: number; naivePct: number; blockPct: number; w: number; h: number; nb: Box | null; bb: Box | null }> = [];
  for (let i = 0; i < crops.length; i += 1) {
    const a = await analyse(crops[i]);
    if (!a || !a.naive) continue;
    n += 1;
    const img = a.w * a.h;
    const naiveTrim = pad(a.naive, a.w, a.h, PAD);
    const naivePct = (1 - area(naiveTrim) / img) * 100;
    let blockPct = naivePct;
    if (a.block) { const bt = pad(a.block, a.w, a.h, PAD); blockPct = (1 - area(bt) / img) * 100; }
    sumNaive += naivePct; sumBlock += blockPct;
    // "dragged to bottom" = naive bbox reaches the lower 25% but the content block ends in the top 60%.
    if (a.naive.y1 > a.h * 0.75 && a.block && a.block.y1 < a.h * 0.6) draggedToBottom += 1;
    rows.push({ i, naivePct: Math.round(naivePct * 10) / 10, blockPct: Math.round(blockPct * 10) / 10, w: a.w, h: a.h, nb: a.naive, bb: a.block });
  }
  rows.sort((p, q) => (q.blockPct - q.naivePct) - (p.blockPct - p.naivePct));

  console.log(`==== NAIVE bbox vs CONTENT-BLOCK trim (n=${n}, PAD=${PAD}, CONTENT_DARK=${CONTENT_DARK}) ====`);
  console.log(`mean area removed — NAIVE bbox ........ ${(sumNaive / n).toFixed(1)}%`);
  console.log(`mean area removed — CONTENT BLOCK ..... ${(sumBlock / n).toFixed(1)}%`);
  console.log(`crops where the naive bbox is DRAGGED to the bottom by trailing chrome: ${draggedToBottom}/${n}`);
  console.log(`\nTop 10 crops where BLOCK recovers the most over naive:`);
  for (const r of rows.slice(0, 10))
    console.log(`  crop#${r.i} ${r.w}x${r.h}: naive removes ${r.naivePct}% → block removes ${r.blockPct}%  (naive y1=${r.nb?.y1}/${r.h}, block y1=${r.bb?.y1})`);

  for (const r of rows.slice(0, 5)) {
    await sharp(crops[r.i]).png().toFile(path.join(outDir, `crop${r.i}-BEFORE.png`));
    if (r.bb) {
      const t = pad(r.bb, r.w, r.h, PAD);
      await sharp(crops[r.i]).extract({ left: t.x0, top: t.y0, width: t.x1 - t.x0 + 1, height: t.y1 - t.y0 + 1 }).png()
        .toFile(path.join(outDir, `crop${r.i}-BLOCK.png`));
    }
  }
  console.log(`\nbefore/block examples → ${outDir}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
