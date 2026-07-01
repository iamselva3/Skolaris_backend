/* eslint-disable no-console */
/**
 * Validation for the display-only explanation/footer strip (crop-strip-explanation.ts).
 *
 *   1. OCR-IDENTITY — segment the paper with OCR_DISPLAY_EXPLANATION_TRIM off vs on and diff
 *      every draft (count / questionNumber / optionCount / invalidCrop / sourceCoordinates).
 *      The strip only rewrites saved bytes, so these MUST be 0 (180/180 preserved).
 *   2. STRIP EFFECT — pair the off/on crop heights and report how many crops were shortened
 *      (a footer removed) vs kept (the no-op fallback). On the question-only regression
 *      baselines this should be 0 shortened ⇒ proven NO-OP.
 *   3. Saves BEFORE/AFTER PNGs for any crop that was shortened (for visual inspection).
 *
 *   npx ts-node scripts/diag-explanation-validate.ts "<pdf>" [outDir]
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
  on: boolean,
  pageBuffers: Buffer[],
  cleaned: Buffer[],
  wordsByPage: OcrWordBox[][],
  flat: any,
  mask: any,
): Promise<{ drafts: OcrEngineDraft[]; crops: Buffer[]; nums: Array<number | null> }> => {
  if (on) process.env.OCR_DISPLAY_EXPLANATION_TRIM = 'true';
  else delete process.env.OCR_DISPLAY_EXPLANATION_TRIM;
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
  delete process.env.OCR_DISPLAY_EXPLANATION_TRIM;
  return { drafts, crops, nums };
};

const main = async (): Promise<void> => {
  const file = process.argv[2];
  const outDir = process.argv[3] || path.join(path.dirname(file), 'expl-trim');
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

  const hOf = async (b: Buffer) => (await sharp(b).metadata()).height ?? 0;
  let shortened = 0;
  const cut: Array<{ i: number; n: number | null; from: number; to: number }> = [];
  for (let i = 0; i < on.crops.length; i += 1) {
    const a0 = await hOf(off.crops[i]);
    const a1 = await hOf(on.crops[i]);
    if (a1 < a0 - 1) { shortened += 1; cut.push({ i, n: on.nums[i], from: a0, to: a1 }); }
  }

  console.log(`\n============ EXPLANATION-STRIP VALIDATION ============`);
  console.log(`file ............... ${path.basename(file)} (${pages.length} pages)`);
  console.log(`draft count ........ off=${off.drafts.length} on=${on.drafts.length} ${off.drafts.length === on.drafts.length ? 'IDENTICAL' : '*** DIFF ***'}`);
  console.log(`per-draft diffs .... ${diffs} ${diffs === 0 ? 'IDENTICAL ✅' : '*** DIFF ***'}`);
  console.log(`crops shortened .... ${shortened}/${on.crops.length} ${shortened === 0 ? '(NO-OP ✅)' : ''}`);
  for (const c of cut.slice(0, 12)) console.log(`  crop#${c.i} Q${c.n}: ${c.from}px -> ${c.to}px`);

  for (const c of cut.slice(0, 12)) {
    await sharp(off.crops[c.i]).png().toFile(path.join(outDir, `Q${c.n ?? '_'}-crop${c.i}-BEFORE.png`));
    await sharp(on.crops[c.i]).png().toFile(path.join(outDir, `Q${c.n ?? '_'}-crop${c.i}-AFTER.png`));
  }
  if (cut.length) console.log(`\nbefore/after → ${outDir}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
