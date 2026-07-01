/* eslint-disable no-console */
/**
 * READ-ONLY investigation of PHYCHE.pdf detection mismatch (actual 49 vs detected 53).
 * Lists EVERY draft the unchanged segmenter emits — questionNumber, optionCount, width%,
 * column, y-position, and a text snippet — so we can see WHICH 4 are phantom (SOL lines /
 * option blocks / figure captions / duplicates) and WHERE they sit. Also prints per-page
 * column detection from our preprocess detector. Modifies nothing.
 *
 *   npx ts-node scripts/diag-phyche.ts "C:/Users/hp/Downloads/PHYCHE.pdf"
 */
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { segmentVisualDrafts } from '../src/shared/ocr-engine/visual-segment';
import { detectColumns } from '../src/modules/ocr-preprocess/column-reflow';
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

const main = async (): Promise<void> => {
  const file = process.argv[2];
  const bytes = fs.readFileSync(file);
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(bytes, { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  const meta0 = await sharp(pages[0]).metadata();
  const pageW = meta0.width ?? 0;
  const flat = await buildFlatField(pages);
  const mask = buildWatermarkMask(flat);

  console.log(`\n=== PHYCHE column detection (preprocess) ===`);
  for (let i = 0; i < pages.length; i += 1) {
    const lay = await detectColumns(pages[i]);
    console.log(`  p${i + 1}: cols=${lay.columns} conf=${lay.confidence} minInk=${lay.minColumnInk} ${lay.reason}`);
  }

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

  console.log(`\n=== PHYCHE drafts: ${drafts.length} (actual=49) ===`);
  for (let i = 0; i < drafts.length; i += 1) {
    const d = drafts[i];
    const c = d.sourceCoordinates;
    const wPct = c && pageW ? Math.round(((c.x1 - c.x0) / pageW) * 100) : 0;
    const snippet = (d.text ?? '').replace(/\s+/g, ' ').slice(0, 70);
    console.log(
      `  #${i + 1} p${pageOf[i]} Q${d.questionNumber ?? '∅'} opts=${d.optionCount ?? 0} w=${wPct}% ` +
        `col=${d.sourceColumn ?? '?'}/${d.sourceColumnCount ?? 1} ` +
        `y=[${c?.y0 ?? '?'}..${c?.y1 ?? '?'}] x=[${c?.x0 ?? '?'}..${c?.x1 ?? '?'}] ` +
        `${d.invalidCrop ? 'INVALID ' : ''}${(d.optionCount ?? 0) < 4 ? '<4opts ' : ''}| "${snippet}"`,
    );
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
