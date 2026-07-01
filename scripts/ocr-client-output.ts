/* eslint-disable no-console */
/**
 * FINAL CLIENT-OUTPUT verification. Runs the ENTIRE production path on a real upload exactly as the
 * wired OcrJobRunner now does: engine → (per-page words+images) → OcrAnalysisDeliveryService (full
 * analyzePaper stack: PageAnalyzer→8 detectors→CorrectionApplier→QuestionLifecycle→validation→gate→
 * bridge) → final delivered draft set. Emits the per-question client-output table. NO shortcuts, no
 * synthetic input, no per-detector tests.
 *   npx ts-node scripts/ocr-client-output.ts "<pdf>"
 */
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { cleanPageForDisplay } from '../src/shared/ocr-engine/crop-display-clean';
import { segmentVisualDrafts } from '../src/shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';
import type { OcrEngineDraft } from '../src/shared/ocr-engine/ocr-engine';
import { OcrAnalysisDeliveryService, DeliverableDraft } from '../src/modules/ocr-analysis/ocr-analysis-delivery.service';
import { OcrShadowAnalyzer } from '../src/modules/ocr-analysis/ocr-shadow-analyzer';
import { PageAnalyzer } from '../src/modules/ocr-analysis/page-analyzer';
import { PaperAnalyzer } from '../src/modules/ocr-analysis/paper-analyzer';
import { buildDetectors } from '../src/modules/ocr-analysis/detectors';
import { ShadowIntegrityValidator } from '../src/modules/ocr-analysis/integrity-validator';
import { CountReconciler } from '../src/modules/ocr-analysis/count-reconciler';
import { ReviewQueueRouter } from '../src/modules/ocr-analysis/review-queue';
import { QuestionLifecycleEngine } from '../src/modules/ocr-analysis/lifecycle';
import { MultiColumnStartHook } from '../src/modules/ocr-analysis/multi-column';
import { WideContentExpandHook } from '../src/modules/ocr-analysis/wide-content';
import { SplitQuestionExpandHook } from '../src/modules/ocr-analysis/split-question';
import { CrossPageExpandHook } from '../src/modules/ocr-analysis/cross-page';
import { HandwrittenStartHook } from '../src/modules/ocr-analysis/handwritten';
import { ExplanationFinalizeHook } from '../src/modules/ocr-analysis/explanation';
import { CorrectionApplier } from '../src/modules/ocr-analysis/correction-applier';

const collectWordBoxes = (d: any): OcrWordBox[] => {
  const out: OcrWordBox[] = [];
  for (const b of d?.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) for (const wd of l.words ?? []) {
    const t = (wd.text ?? '').trim(); if (!t || !wd.bbox) continue;
    const { x0, y0, x1, y1 } = wd.bbox; if ([x0, y0, x1, y1].some((v) => typeof v !== 'number')) continue;
    out.push({ text: t, x0, y0, x1, y1 });
  }
  return out;
};
const buildAnalyzer = (): OcrShadowAnalyzer =>
  new OcrShadowAnalyzer(new PageAnalyzer(), buildDetectors(), new ShadowIntegrityValidator(), new PaperAnalyzer(),
    new CountReconciler(), new ReviewQueueRouter(), new QuestionLifecycleEngine(), new MultiColumnStartHook(),
    new WideContentExpandHook(), new SplitQuestionExpandHook(), new CrossPageExpandHook(), new HandwrittenStartHook(),
    new ExplanationFinalizeHook(), new CorrectionApplier());
const SOL = /\b(sol\.?|solution|explanation|hint|ans\.?\s*[:=]|because|since|hence)\b/i;

const run = async (file: string): Promise<void> => {
  const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(fs.readFileSync(file), { scale: 2 });
  const pages: Buffer[] = []; for await (const p of doc) pages.push(p as Buffer);
  const flat = await buildFlatField(pages); const mask = buildWatermarkMask(flat);
  const store = new Map<string, Buffer>(); // in-memory object storage for crops
  const putObject = async (key: string, body: Buffer) => { store.set(key, body); };
  const worker = await createWorker('eng');
  const wordsByPage: Array<{ text: string; x0: number; y0: number; x1: number; y1: number }[]> = [];
  const base: OcrEngineDraft[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    const clean = await cleanPageImage(pages[i], flat);
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    const wb = collectWordBoxes(data);
    const displayPage = await cleanPageForDisplay(pages[i], flat, mask, wb); // STAGE 0 + chrome (mirrors production)
    const { drafts: vd } = await segmentVisualDrafts(clean, wb, i + 1, { putObject, figureKeyPrefix: 'tenants/t/ocr-figures/job', positionOffset: base.length, displayFlat: flat, displayMask: mask, displaySource: displayPage } as any);
    base.push(...(vd as OcrEngineDraft[]));
    wordsByPage[i] = wb.map((x) => ({ text: x.text, x0: x.x0, y0: x.y0, x1: x.x1, y1: x.y1 }));
  }
  await worker.terminate();

  // EXACT production path: run the delivery adapter the wired runner uses.
  const delivery = new OcrAnalysisDeliveryService(buildAnalyzer());
  const result = await delivery.deliver(base as unknown as DeliverableDraft[], { wordsByPage, pageImages: pages }, {
    getObject: async (k) => store.get(k) ?? Buffer.alloc(0),
    putObject,
    figureKeyPrefix: 'tenants/t/ocr-figures/job/merged',
  });
  const final = result.drafts as unknown as OcrEngineDraft[];

  // Old crops claiming each question number (base) vs final crops (delivered).
  const baseByNum = new Map<number, OcrEngineDraft[]>();
  for (const d of base) { const n = d.questionNumber ?? -1; (baseByNum.get(n) ?? baseByNum.set(n, []).get(n)!).push(d); }
  const finalByNum = new Map<number, OcrEngineDraft[]>();
  for (const d of final) { const n = d.questionNumber ?? -1; (finalByNum.get(n) ?? finalByNum.set(n, []).get(n)!).push(d); }

  console.log(`\n==== CLIENT OUTPUT — ${path.basename(file)} ====`);
  console.log(`base engine crops=${base.length} → delivered crops=${final.length} | removed=${result.removed} splitMerged=${result.splitMerged} crossPageMerged=${result.crossPageMerged} | N=N=${result.deliverable}`);
  console.log('\nQuestion | Page | Old crops | Final crops | Q+Options together | Solution removed | PASS/FAIL');
  let pass = 0; let fail = 0; const fails: string[] = [];
  const nums = [...finalByNum.keys()].filter((n) => n >= 0).sort((a, b) => a - b);
  for (const n of nums) {
    const fin = finalByNum.get(n)!;
    const old = baseByNum.get(n) ?? [];
    const d = fin[0];
    const page = d.sourcePageNumber ?? 0;
    const together = (d.optionCount ?? 0) >= 2; // stem (numbered) + options present in the one crop
    const solRemoved = !SOL.test((d.solutionText ?? '') + ' ' + (d.text ?? '').split('\n').slice(-2).join(' '));
    const ok = fin.length === 1 && together && solRemoved;
    if (ok) pass += 1; else { fail += 1; fails.push(`Q${n}(p${page}) crops=${fin.length} together=${together} solRemoved=${solRemoved}`); }
    if (nums.length <= 60 || !ok || old.length !== 1) {
      console.log(`Q${n} | ${page} | ${old.length} | ${fin.length} | ${together ? 'YES' : 'NO'} | ${solRemoved ? 'YES' : 'NO'} | ${ok ? 'PASS' : 'FAIL'}`);
    }
  }
  console.log(`\n(rows with Old=Final=1/together/sol-removed collapsed when >60 questions; all FAILs + all splits/merges always shown)`);
  console.log(`\nSUMMARY: ${pass} PASS / ${fail} FAIL  (delivered ${final.length} crops)`);
  if (fails.length) console.log('FAILS:\n' + fails.map((f) => '  ❌ ' + f).join('\n'));
};
run(process.argv[2] ?? 'C:/Users/hp/Downloads/Biology_Cell.pdf').catch((e) => { console.error(e); process.exit(1); });
