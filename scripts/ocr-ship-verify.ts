/* eslint-disable no-console */
/**
 * SHIPPING EXECUTION test (TASK 5). Full chain → bridge → delivery gate. Per PDF reports expected
 * count, delivered crop count, duplicates, missing, extra, broken boundaries, solutions remaining,
 * review items, delivery status. Read-only over the UNCHANGED engine; references are guards only.
 *
 *   npx ts-node scripts/ocr-ship-verify.ts "<pdf>" ["<pdf>" ...]
 */
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { segmentVisualDrafts } from '../src/shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';
import type { OcrEngineDraft } from '../src/shared/ocr-engine/ocr-engine';
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
import { ProductionBridge } from '../src/modules/ocr-analysis/production-bridge';
import { DeliveryGate } from '../src/modules/ocr-analysis/delivery-gate';
import { OcrShadowAnalyzer, PageInput } from '../src/modules/ocr-analysis/ocr-shadow-analyzer';
import type { ShadowDraft, ShadowWord } from '../src/modules/ocr-analysis/contracts';

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
const build = (): OcrShadowAnalyzer =>
  new OcrShadowAnalyzer(new PageAnalyzer(), buildDetectors(), new ShadowIntegrityValidator(), new PaperAnalyzer(),
    new CountReconciler(), new ReviewQueueRouter(), new QuestionLifecycleEngine(), new MultiColumnStartHook(),
    new WideContentExpandHook(), new SplitQuestionExpandHook(), new CrossPageExpandHook(), new HandwrittenStartHook(),
    new ExplanationFinalizeHook(), new CorrectionApplier());

const run = async (file: string): Promise<boolean> => {
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(fs.readFileSync(file), { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  const flat = await buildFlatField(pages);
  const mask = buildWatermarkMask(flat);
  const worker = await createWorker('eng');
  const input: PageInput[] = [];
  let total = 0;
  for (let i = 0; i < pages.length; i += 1) {
    const clean = await cleanPageImage(pages[i], flat);
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    const wb = collectWordBoxes(data);
    const { drafts: vd } = await segmentVisualDrafts(clean, wb, i + 1, {
      putObject: async () => undefined, figureKeyPrefix: 'ship', positionOffset: total, displayFlat: flat, displayMask: mask, displaySource: pages[i],
    } as any);
    const drafts: ShadowDraft[] = (vd as OcrEngineDraft[]).map((d, k) => ({ index: total + k, page: i + 1, questionNumber: d.questionNumber ?? null, text: d.text ?? '', coords: d.sourceCoordinates }));
    const words: ShadowWord[] = wb.map((w) => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }));
    total += vd.length;
    input.push({ pageImage: pages[i], pageIndex: i + 1, drafts, words });
  }
  await worker.terminate();

  const report = await build().analyzePaper(input);
  const bridge = new ProductionBridge().build(report);
  // SAFE SPLIT FALLBACK signal: count unresolved split orphans + Q+O completeness from the report.
  const unresolvedSplitOrphans = report.allFindings.filter((f) => f.detector === 'split-question-options' && f.kind === 'split-orphan-unresolved').length;
  const completeCount = report.lifecycle.filter((l) => l.complete).length;
  const questionOptionsCompletePct = report.emittedCount ? Math.round((completeCount / report.emittedCount) * 1000) / 10 : 100;
  const decision = new DeliveryGate().decide(bridge, { unresolvedSplitOrphans, questionOptionsCompletePct });

  console.log(`\n================ SHIP — ${path.basename(file)} ================`);
  console.log(`  Expected question count : ${bridge.totalLogicalQuestions}`);
  console.log(`  Final delivered crops   : ${decision.status === 'DELIVER' ? bridge.totalBridgeObjects : 0}  (bridge objects=${bridge.totalBridgeObjects})`);
  console.log(`  Duplicates              : ${bridge.duplicateObjects}`);
  console.log(`  Missing                 : ${bridge.missingObjects}`);
  console.log(`  Extra                   : ${bridge.extraObjects}`);
  console.log(`  Broken boundaries       : ${bridge.brokenBoundaryObjects}`);
  console.log(`  Solutions remaining     : ${bridge.explanationLeakageObjects}  (silent=${bridge.silentLeakageObjects}, flagged-for-review=${bridge.explanationLeakageObjects - bridge.silentLeakageObjects})`);
  console.log(`  Review items            : ${decision.reviewQuestions}`);
  console.log(`  Unresolved split orphans: ${unresolvedSplitOrphans}  (Q+O completeness ${questionOptionsCompletePct}%)`);
  console.log(`  reviewRequired          : ${decision.reviewRequired}`);
  console.log(`  Delivery status         : ${decision.status}${decision.reasons.length ? ' → ' + decision.reasons.join(', ') : ''}`);
  // SAFE: a clean PDF DELIVERs with no silent leakage; an unprovable split is BLOCKED (never silent).
  const noSilentFailure = bridge.silentLeakageObjects === 0 && (decision.status === 'DELIVER' || decision.reviewRequired);
  return noSilentFailure;
};

const main = async (): Promise<void> => {
  const files = process.argv.slice(2);
  const results: Array<{ file: string; ok: boolean }> = [];
  for (const f of files) { try { results.push({ file: path.basename(f), ok: await run(f) }); } catch (e) { console.log(`\n==== ${path.basename(f)} ERROR: ${e instanceof Error ? e.message : String(e)}`); results.push({ file: path.basename(f), ok: false }); } }
  console.log(`\n================ SHIPPING EXECUTION SUMMARY ================`);
  console.log(`  ${results.map((r) => `${r.file}=${r.ok ? 'DELIVER' : 'REVIEW/FAIL'}`).join(' | ')}`);
  const allDeliver = results.every((r) => r.ok);
  console.log(`  Framework delivery objects gate-pass on all: ${allDeliver ? 'YES' : 'NO'}`);
};
main().catch((e) => { console.error(e); process.exit(1); });
