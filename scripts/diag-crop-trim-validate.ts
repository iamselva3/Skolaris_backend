/* eslint-disable no-console */
/**
 * Validation for the display-only crop trim (crop-display-trim.ts):
 *   1. OCR-IDENTITY — segment the paper with OCR_DISPLAY_CROP_TRIM off vs on and diff
 *      every draft (count / questionNumber / sourceCoordinates). Trim only rewrites saved
 *      bytes, so these must be 0 (180/180 preserved).
 *   2. TRIM EFFECT — pair the off/on crop buffers and report area reduction + how many
 *      crops were trimmed vs kept (low-confidence fallback).
 *   3. Saves BEFORE/AFTER PNGs for the emptiest crops, plus the requested examples
 *      (Q176, Q180) and a diagram question (Q108) for visual no-clipping confirmation.
 *
 *   npx ts-node scripts/diag-crop-trim-validate.ts "<pdf>" [outDir]
 */
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { segmentVisualDrafts } from '../src/shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';
import type { OcrEngineDraft } from '../src/shared/ocr-engine/ocr-engine';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

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

const sig = (d: OcrEngineDraft): string =>
  JSON.stringify({ pos: d.position, n: d.questionNumber, opt: d.optionCount, inv: d.invalidCrop, c: d.sourceCoordinates });

const run = async (
  trimOn: boolean,
  pageBuffers: Buffer[],
  cleaned: Buffer[],
  wordsByPage: OcrWordBox[][],
  flat: any,
  mask: any,
): Promise<{ drafts: OcrEngineDraft[]; crops: Buffer[]; nums: Array<number | null> }> => {
  if (trimOn) delete process.env.OCR_DISPLAY_CROP_TRIM;
  else process.env.OCR_DISPLAY_CROP_TRIM = 'false';
  const drafts: OcrEngineDraft[] = [];
  const crops: Buffer[] = [];
  const nums: Array<number | null> = [];
  const putObject = async (_k: string, body: Buffer): Promise<void> => { crops.push(body); };
  for (let i = 0; i < pageBuffers.length; i += 1) {
    const { drafts: vd } = await segmentVisualDrafts(cleaned[i], wordsByPage[i], i + 1, {
      putObject, figureKeyPrefix: 'diag', positionOffset: drafts.length,
      displayFlat: flat, displayMask: mask, displaySource: pageBuffers[i],
    } as any);
    for (const d of vd) nums.push(d.questionNumber ?? null);
    drafts.push(...vd);
  }
  delete process.env.OCR_DISPLAY_CROP_TRIM;
  return { drafts, crops, nums };
};

const main = async (): Promise<void> => {
  const file = process.argv[2];
  const outDir = process.argv[3] || path.join(path.dirname(file), 'crop-trim');
  fs.mkdirSync(outDir, { recursive: true });
  const bytes = fs.readFileSync(file);
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(bytes, { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  const flat = await buildFlatField(pages);
  const mask = buildWatermarkMask(flat);

  const worker = await createWorker('eng');
  const cleaned: Buffer[] = [];
  const wordsByPage: OcrWordBox[][] = [];
  for (let i = 0; i < pages.length; i += 1) {
    const clean = await cleanPageImage(pages[i], flat);
    cleaned.push(clean);
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    wordsByPage.push(collectWordBoxes(data));
    process.stdout.write(`\rOCR ${i + 1}/${pages.length}`);
  }
  await worker.terminate();
  console.log('');

  const off = await run(false, pages, cleaned, wordsByPage, flat, mask);
  const on = await run(true, pages, cleaned, wordsByPage, flat, mask);

  // 1. identity
  let diffs = 0;
  const m = Math.max(off.drafts.length, on.drafts.length);
  for (let i = 0; i < m; i += 1) if (sig(off.drafts[i] ?? ({} as any)) !== sig(on.drafts[i] ?? ({} as any))) diffs += 1;

  // 2. trim effect
  let trimmed = 0;
  let sumReduce = 0;
  const dims = async (b: Buffer) => { const mm = await sharp(b).metadata(); return (mm.width ?? 0) * (mm.height ?? 0); };
  const reductions: Array<{ i: number; pct: number; n: number | null }> = [];
  for (let i = 0; i < on.crops.length; i += 1) {
    const a0 = await dims(off.crops[i]);
    const a1 = await dims(on.crops[i]);
    const reduce = a0 > 0 ? 1 - a1 / a0 : 0;
    if (reduce > 0.001) trimmed += 1;
    sumReduce += reduce;
    reductions.push({ i, pct: Math.round(reduce * 1000) / 10, n: on.nums[i] });
  }
  reductions.sort((p, q) => q.pct - p.pct);

  console.log(`\n================ CROP-TRIM VALIDATION ================`);
  console.log(`draft count ........ off=${off.drafts.length} on=${on.drafts.length} ${off.drafts.length === on.drafts.length ? 'IDENTICAL' : 'DIFF'}`);
  console.log(`per-draft diffs (number/coords/options): ${diffs} ${diffs === 0 ? 'IDENTICAL ✅' : '*** DIFF ***'}`);
  console.log(`crops trimmed ...... ${trimmed}/${on.crops.length}  (kept as-is: ${on.crops.length - trimmed})`);
  console.log(`mean area removed .. ${(100 * sumReduce / on.crops.length).toFixed(1)}%`);
  console.log(`\nTop 8 trimmed (area removed):`);
  for (const r of reductions.slice(0, 8)) console.log(`  crop#${r.i} Q${r.n}: -${r.pct}%`);

  // 3. save before/after for the emptiest + requested examples
  const wanted = new Set<number>(reductions.slice(0, 4).map((r) => r.i));
  for (const target of [176, 180, 108]) {
    const idx = on.nums.findIndex((n) => n === target);
    if (idx >= 0) wanted.add(idx);
  }
  for (const i of wanted) {
    const n = on.nums[i];
    await sharp(off.crops[i]).png().toFile(path.join(outDir, `Q${n ?? '_'}-crop${i}-BEFORE.png`));
    await sharp(on.crops[i]).png().toFile(path.join(outDir, `Q${n ?? '_'}-crop${i}-AFTER.png`));
  }
  console.log(`\nbefore/after → ${outDir}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
