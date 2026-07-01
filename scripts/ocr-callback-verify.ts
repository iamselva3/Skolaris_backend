/* eslint-disable no-console */
/**
 * Verifies the PRODUCTION SEAM (HandleOcrCallback) correction: feeds the engine's drafts through
 * CallbackCorrectionService (the exact path the live callback now uses) and reports the corrected
 * persisted SET. Confirms N=N + the content-numeral/duplicate removals match the validated framework.
 *
 *   npx ts-node scripts/ocr-callback-verify.ts "<pdf>" ["<pdf>" ...]
 */
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { segmentVisualDrafts } from '../src/shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';
import type { OcrEngineDraft } from '../src/shared/ocr-engine/ocr-engine';
import { CallbackCorrectionService, CallbackDraftLike } from '../src/modules/ocr-analysis/callback-correction';
import { DeliveryGate } from '../src/modules/ocr-analysis/delivery-gate';

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

const run = async (file: string): Promise<void> => {
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(fs.readFileSync(file), { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  const flat = await buildFlatField(pages);
  const mask = buildWatermarkMask(flat);
  const worker = await createWorker('eng');
  const callbackDrafts: CallbackDraftLike[] = [];
  let total = 0;
  for (let i = 0; i < pages.length; i += 1) {
    const clean = await cleanPageImage(pages[i], flat);
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    const { drafts: vd } = await segmentVisualDrafts(clean, collectWordBoxes(data), i + 1, {
      putObject: async () => undefined, figureKeyPrefix: 'cb', positionOffset: total, displayFlat: flat, displayMask: mask, displaySource: pages[i],
    } as any);
    for (const d of vd as OcrEngineDraft[]) {
      callbackDrafts.push({ position: total, text: d.text ?? '', questionNumber: d.questionNumber ?? null, sourcePageNumber: i + 1, sourceCoordinates: d.sourceCoordinates as any });
      total += 1;
    }
  }
  await worker.terminate();

  const svc = new CallbackCorrectionService(new DeliveryGate());
  const r = svc.correct(callbackDrafts);
  console.log(`\n==== ${path.basename(file)} ====`);
  console.log(`  engine drafts (base)     : ${callbackDrafts.length}`);
  console.log(`  persisted (corrected SET): ${r.keptPositions.size}`);
  console.log(`  removed                  : ${r.removed.length}${r.removed.length ? ' → ' + r.removed.map((x) => `${x.detector}:${x.kind}@${x.position}`).join(', ') : ''}`);
  console.log(`  delivery gate            : ${r.deliverable ? 'DELIVER ✅' : 'REVIEW ❌ → ' + r.gateReasons.join(', ')}`);
};

const main = async (): Promise<void> => {
  for (const f of process.argv.slice(2)) { try { await run(f); } catch (e) { console.log(`\n==== ${path.basename(f)} ERROR: ${e instanceof Error ? e.message : String(e)}`); } }
};
main().catch((e) => { console.error(e); process.exit(1); });
