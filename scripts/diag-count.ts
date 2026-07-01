/* eslint-disable no-console */
/**
 * READ-ONLY full-pipeline draft count per PDF (real segmentVisualDrafts). Prints total
 * drafts + lists any draft whose OCR text BEGINS with a content-number pattern (locant /
 * unit / option-value) — i.e. a surviving phantom. Used to compare before/after the
 * marker-conflict guard. Loops over all file args.
 *
 *   npx ts-node scripts/diag-count.ts "<pdf>" ["<pdf>" ...]
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
const collectWordBoxes = (d: any): OcrWordBox[] => {
  const out: OcrWordBox[] = [];
  for (const b of d?.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) for (const w of l.words ?? []) {
    const t = (w.text ?? '').trim(); if (!t || !w.bbox) continue;
    const { x0, y0, x1, y1 } = w.bbox; if ([x0, y0, x1, y1].some((v) => typeof v !== 'number')) continue;
    out.push({ text: t, x0, y0, x1, y1 });
  }
  return out;
};
const PHANTOM = /^\s*["'`|]*\d{1,3}(?:[,\-]\d|[A-Za-z]{1,3}(?![A-Za-z]))/; // locant or unit start

const main = async (): Promise<void> => {
  for (const file of process.argv.slice(2)) {
    const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
    const doc = await pdf(fs.readFileSync(file), { scale: 2 });
    const pages: Buffer[] = [];
    for await (const p of doc) pages.push(p as Buffer);
    const flat = await buildFlatField(pages);
    const mask = buildWatermarkMask(flat);
    const worker = await createWorker('eng');
    const drafts: OcrEngineDraft[] = [];
    const pageOf: number[] = [];
    const putObject = async (): Promise<void> => undefined;
    for (let i = 0; i < pages.length; i += 1) {
      const clean = await cleanPageImage(pages[i], flat);
      const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
      const { drafts: vd } = await segmentVisualDrafts(clean, collectWordBoxes(data), i + 1, {
        putObject, figureKeyPrefix: 'diag', positionOffset: drafts.length, displayFlat: flat, displayMask: mask, displaySource: pages[i],
      } as any);
      for (const _ of vd) pageOf.push(i + 1);
      drafts.push(...vd);
    }
    await worker.terminate();
    const phantoms = drafts
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => PHANTOM.test((d.text ?? '').trim()));
    console.log(`\n==== ${path.basename(file)} ==== drafts=${drafts.length}  content-number-start=${phantoms.length}`);
    for (const { d, i } of phantoms) {
      console.log(`   p${pageOf[i]} Q${d.questionNumber ?? '∅'} opts=${d.optionCount ?? 0} | "${(d.text ?? '').replace(/\s+/g, ' ').slice(0, 60)}"`);
    }
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
