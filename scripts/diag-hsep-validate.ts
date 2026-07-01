/* eslint-disable no-console */
/**
 * Validation for the display-only HORIZONTAL page-separator cleanup (Pass 4).
 * Runs segmentation with OCR_DISPLAY_HSEP_CLEANUP off vs on (the crop trim is ON in
 * both, as in production), and reports:
 *   1. OCR IDENTITY — every draft (count / questionNumber / coords / optionCount /
 *      confidence) must be identical (Pass 4 only rewrites saved bytes).
 *   2. METRIC — crops containing a residual full-width ISOLATED horizontal separator
 *      line, before (off) vs after (on).
 *   3. before/after PNGs for crops where the separator was removed, plus Q180 (table),
 *      Q108 (diagram), Q176 — to confirm content is untouched.
 *
 *   npx ts-node scripts/diag-hsep-validate.ts "<pdf>" [outDir]
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
const DARK = 150;

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
  JSON.stringify({ pos: d.position, n: d.questionNumber, opt: d.optionCount, conf: d.confidence, inv: d.invalidCrop, c: d.sourceCoordinates });

// A full-width horizontal line sitting in a blank band (isolated) — the page-separator
// signature. A table/graph border is NOT isolated (dense content rows next to it).
const hasSeparator = async (png: Buffer): Promise<boolean> => {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  for (let y = 0; y < H; y += 1) {
    let dark = 0;
    const row = y * W;
    for (let x = 0; x < W; x += 1) if (data[row + x] < DARK) dark += 1;
    if (dark < 0.6 * W) continue;
    let isolated = true;
    for (let dy = -8; dy <= 8 && isolated; dy += 1) {
      if (Math.abs(dy) <= 1) continue;
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      let d2 = 0;
      for (let x = 0; x < W; x += 1) if (data[yy * W + x] < DARK) d2 += 1;
      if (d2 >= 0.3 * W) isolated = false;
    }
    if (isolated) return true;
  }
  return false;
};

const run = async (
  hsepOn: boolean,
  pageBuffers: Buffer[],
  cleaned: Buffer[],
  wordsByPage: OcrWordBox[][],
  flat: any,
  mask: any,
): Promise<{ drafts: OcrEngineDraft[]; crops: Buffer[]; nums: Array<number | null> }> => {
  if (hsepOn) process.env.OCR_DISPLAY_HSEP_CLEANUP = 'true';
  else delete process.env.OCR_DISPLAY_HSEP_CLEANUP;
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
  delete process.env.OCR_DISPLAY_HSEP_CLEANUP;
  return { drafts, crops, nums };
};

const main = async (): Promise<void> => {
  const file = process.argv[2];
  const outDir = process.argv[3] || path.join(path.dirname(file), 'hsep');
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

  let diffs = 0;
  const m = Math.max(off.drafts.length, on.drafts.length);
  for (let i = 0; i < m; i += 1) if (sig(off.drafts[i] ?? ({} as any)) !== sig(on.drafts[i] ?? ({} as any))) diffs += 1;

  let sepOff = 0, sepOn = 0, removed = 0;
  const removedIdx: number[] = [];
  const remainingIdx: number[] = [];
  for (let i = 0; i < on.crops.length; i += 1) {
    const a = await hasSeparator(off.crops[i]);
    const b = await hasSeparator(on.crops[i]);
    if (a) sepOff += 1;
    if (b) { sepOn += 1; remainingIdx.push(i); }
    if (a && !b) { removed += 1; removedIdx.push(i); }
  }

  console.log(`\n================ HSEP VALIDATION ================`);
  console.log(`draft count ........ off=${off.drafts.length} on=${on.drafts.length} ${off.drafts.length === on.drafts.length ? 'IDENTICAL' : 'DIFF'}`);
  console.log(`per-draft diffs (number/coords/options/confidence): ${diffs} ${diffs === 0 ? 'IDENTICAL ✅' : '*** DIFF ***'}`);
  console.log(`crops with a residual separator — BEFORE: ${sepOff}   AFTER: ${sepOn}   removed: ${removed}`);
  console.log(`removed-separator crops:   ${removedIdx.map((i) => `#${i}(Q${on.nums[i]})`).join(', ')}`);
  console.log(`STILL-with-separator crops: ${remainingIdx.map((i) => `#${i}(Q${on.nums[i]})`).join(', ')}`);

  const wanted = new Set<number>([...removedIdx, ...remainingIdx]);
  for (const target of [176, 180, 108]) {
    const idx = on.nums.findIndex((n) => n === target);
    if (idx >= 0) wanted.add(idx);
  }
  for (const i of wanted) {
    const n = on.nums[i];
    const tag = remainingIdx.includes(i) ? 'REMAIN' : 'rm';
    await sharp(off.crops[i]).png().toFile(path.join(outDir, `${tag}-Q${n ?? '_'}-crop${i}-OFF.png`));
    await sharp(on.crops[i]).png().toFile(path.join(outDir, `${tag}-Q${n ?? '_'}-crop${i}-ON.png`));
  }
  console.log(`\nbefore/after → ${outDir}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
