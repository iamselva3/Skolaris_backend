/* eslint-disable no-console */
/**
 * Measures how much BLANK MARGIN surrounds the real display crops on the RE NEET PST
 * paper, and how much a content-bbox + padding trim would recover — evidence for the
 * display-only trim proposal. Runs the production segmentation (OCR + segmentVisualDrafts
 * with the display flat/mask) and captures the SAME displayCrop bytes that get saved,
 * then for each crop computes the non-white content bounding box.
 *
 *   npx ts-node scripts/diag-crop-whitespace.ts "<pdf>" [outDir]
 */
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { segmentVisualDrafts } from '../src/shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

const WHITE = Number(process.env.TRIM_WHITE ?? 240); // luma >= WHITE ⇒ background
const PAD = Number(process.env.TRIM_PAD ?? 12); // px padding kept around content
const MIN_CONTENT_FRAC = Number(process.env.TRIM_MIN_CONTENT ?? 0.005); // confidence gate

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

interface Measure {
  w: number;
  h: number;
  bx0: number;
  by0: number;
  bx1: number;
  by1: number;
  contentPx: number;
}

const measure = async (png: Buffer): Promise<Measure | null> => {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  let bx0 = w;
  let by0 = h;
  let bx1 = -1;
  let by1 = -1;
  let contentPx = 0;
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      if (data[y * w + x] < WHITE) {
        contentPx += 1;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
    }
  if (bx1 < 0) return null; // fully blank
  return { w, h, bx0, by0, bx1, by1, contentPx };
};

const main = async (): Promise<void> => {
  const file = process.argv[2];
  const outDir = process.argv[3] || path.join(path.dirname(file), 'crop-whitespace');
  fs.mkdirSync(outDir, { recursive: true });
  const bytes = fs.readFileSync(file);
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(bytes, { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  const flat = await buildFlatField(pages);
  const mask = buildWatermarkMask(flat);
  console.log(`pages=${pages.length}  WHITE>=${WHITE} PAD=${PAD} MIN_CONTENT_FRAC=${MIN_CONTENT_FRAC}\n`);

  const worker = await createWorker('eng');
  const crops: Buffer[] = [];
  const putObject = async (_key: string, body: Buffer): Promise<void> => {
    crops.push(body);
  };
  let offset = 0;
  for (let i = 0; i < pages.length; i += 1) {
    const clean = await cleanPageImage(pages[i], flat);
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    const wordBoxes = collectWordBoxes(data);
    const { drafts } = await segmentVisualDrafts(clean, wordBoxes, i + 1, {
      putObject,
      figureKeyPrefix: 'diag',
      positionOffset: offset,
      displayFlat: flat,
      displayMask: mask,
      displaySource: pages[i],
    } as any);
    offset += drafts.length;
    process.stdout.write(`\rOCR+segment page ${i + 1}/${pages.length} · crops=${crops.length}`);
  }
  await worker.terminate();
  console.log('\n');

  let n = 0;
  let blank = 0;
  let lowConf = 0;
  let sumWhite = 0;
  let sumTrimGain = 0;
  let over40 = 0;
  let over60 = 0;
  const sides = { top: 0, bottom: 0, left: 0, right: 0 };
  const worst: Array<{ idx: number; whitePct: number; m: Measure }> = [];

  for (let i = 0; i < crops.length; i += 1) {
    const m = await measure(crops[i]);
    if (!m) {
      blank += 1;
      continue;
    }
    n += 1;
    const imgArea = m.w * m.h;
    const bboxArea = (m.bx1 - m.bx0 + 1) * (m.by1 - m.by0 + 1);
    const whiteFrac = 1 - bboxArea / imgArea;
    const contentFrac = m.contentPx / imgArea;
    // trim = bbox + PAD, clamped to image
    const tx0 = Math.max(0, m.bx0 - PAD);
    const ty0 = Math.max(0, m.by0 - PAD);
    const tx1 = Math.min(m.w - 1, m.bx1 + PAD);
    const ty1 = Math.min(m.h - 1, m.by1 + PAD);
    const trimArea = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
    const lowConfidence = contentFrac < MIN_CONTENT_FRAC || bboxArea / imgArea > 0.92;
    if (lowConfidence) lowConf += 1;
    const gain = lowConfidence ? 0 : 1 - trimArea / imgArea; // area removed by trim
    sumWhite += whiteFrac;
    sumTrimGain += gain;
    if (whiteFrac > 0.4) over40 += 1;
    if (whiteFrac > 0.6) over60 += 1;
    sides.top += m.by0 / m.h;
    sides.bottom += (m.h - 1 - m.by1) / m.h;
    sides.left += m.bx0 / m.w;
    sides.right += (m.w - 1 - m.bx1) / m.w;
    worst.push({ idx: i, whitePct: Math.round(whiteFrac * 1000) / 10, m });
  }

  worst.sort((a, b) => b.whitePct - a.whitePct);
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  console.log(`==== CROP WHITESPACE (n=${n} measured, ${blank} fully-blank) ====`);
  console.log(`mean surrounding whitespace .......... ${pct(sumWhite / n)}`);
  console.log(`crops with >40% whitespace ........... ${over40} (${pct(over40 / n)})`);
  console.log(`crops with >60% whitespace ........... ${over60} (${pct(over60 / n)})`);
  console.log(`mean blank margin per side: top=${pct(sides.top / n)} bottom=${pct(sides.bottom / n)} left=${pct(sides.left / n)} right=${pct(sides.right / n)}`);
  console.log(`\n==== AFTER content-bbox + ${PAD}px trim (low-confidence kept as-is) ====`);
  console.log(`would TRIM ............................ ${n - lowConf}/${n} crops`);
  console.log(`kept as-is (low confidence) .......... ${lowConf}`);
  console.log(`mean image-area removed by trim ...... ${pct(sumTrimGain / n)}`);
  console.log(`\nTop 8 emptiest crops (whitespace%):`);
  for (const w of worst.slice(0, 8))
    console.log(`  crop#${w.idx}: ${w.whitePct}%  (img ${w.m.w}x${w.m.h}, content bbox ${w.m.bx1 - w.m.bx0 + 1}x${w.m.by1 - w.m.by0 + 1})`);

  // Save a few before/after examples for visual confirmation.
  for (const w of worst.slice(0, 4)) {
    const m = w.m;
    const tx0 = Math.max(0, m.bx0 - PAD);
    const ty0 = Math.max(0, m.by0 - PAD);
    const tx1 = Math.min(m.w - 1, m.bx1 + PAD);
    const ty1 = Math.min(m.h - 1, m.by1 + PAD);
    await sharp(crops[w.idx]).png().toFile(path.join(outDir, `crop${w.idx}-BEFORE.png`));
    await sharp(crops[w.idx])
      .extract({ left: tx0, top: ty0, width: tx1 - tx0 + 1, height: ty1 - ty0 + 1 })
      .png()
      .toFile(path.join(outDir, `crop${w.idx}-AFTER.png`));
  }
  console.log(`\nbefore/after examples written to: ${outDir}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
