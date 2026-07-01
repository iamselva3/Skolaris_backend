/* eslint-disable no-console */
/**
 * READ-ONLY probe for SPLIT-LAYOUT questions (stem region separated from its A/B/C/D
 * option region — vertically or across columns). Runs the real segmentVisualDrafts and
 * flags, per PDF:
 *   ORPHAN-OPTION : a draft whose text BEGINS with an option label (A/B/C/D / (1)) and has
 *                   essentially NO stem — i.e. an "option-only region" (a continuation
 *                   candidate that must NOT become its own question).
 *   STARVED-STEM  : a draft with a question number but < 2 option labels (possible options
 *                   lost to a separate region).
 * Lets us see whether the marker-conflict fix + full-width regions already absorb split
 * options, or whether genuine orphans/lost-options remain. Modifies nothing.
 *
 *   npx ts-node scripts/diag-split.ts "<pdf>" ["<pdf>" ...]
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
const stripNoise = (s: string): string => (s ?? '').replace(/^["'`|.,;:_\-—\s]+/, '');
const OPTION_START = /^\(?([A-Da-d])[.)]|^\(([1-4])\)/; // starts with A) (A) A. (1)
const NUM_START = /^\d{1,3}[.):;,]/;

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

    const orphans: number[] = [];
    const starved: number[] = [];
    for (let i = 0; i < drafts.length; i += 1) {
      const t = stripNoise(drafts[i].text ?? '');
      const startsOption = OPTION_START.test(t) && !NUM_START.test(t);
      const stemLen = t.replace(OPTION_START, '').replace(/[A-Da-d][.)]/g, '').trim().length;
      if (startsOption && stemLen < 8) orphans.push(i);
      if ((drafts[i].optionCount ?? 0) < 2) starved.push(i);
    }
    console.log(`\n==== ${path.basename(file)} ==== drafts=${drafts.length} ORPHAN-OPTION=${orphans.length} STARVED-STEM=${starved.length}`);
    for (const i of orphans) console.log(`   ORPHAN  p${pageOf[i]} Q${drafts[i].questionNumber ?? '∅'} opts=${drafts[i].optionCount ?? 0} | "${(drafts[i].text ?? '').replace(/\s+/g, ' ').slice(0, 56)}"`);
    for (const i of starved.slice(0, 12)) console.log(`   STARVED p${pageOf[i]} Q${drafts[i].questionNumber ?? '∅'} opts=${drafts[i].optionCount ?? 0} | "${(drafts[i].text ?? '').replace(/\s+/g, ' ').slice(0, 56)}"`);
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
