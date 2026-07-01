/* eslint-disable no-console */
/**
 * ENTERPRISE VALIDATION runner (shadow). For ANY uploaded MCQ PDF, runs the UNCHANGED OCR engine
 * read-only → the framework's analyzePaper → the EnterpriseValidator, and prints the 11-field
 * enterprise validation report + acceptance. Generic: pass it any PDF. The 5 reference PDFs are
 * regression GUARDS only — never targets.
 *
 *   npx ts-node scripts/ocr-enterprise-validate.ts "<pdf>" ["<pdf>" ...]
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
import { EnterpriseValidator } from '../src/modules/ocr-analysis/enterprise-validation';
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
const buildAnalyzer = (): OcrShadowAnalyzer =>
  new OcrShadowAnalyzer(
    new PageAnalyzer(), buildDetectors(), new ShadowIntegrityValidator(), new PaperAnalyzer(),
    new CountReconciler(), new ReviewQueueRouter(), new QuestionLifecycleEngine(),
    new MultiColumnStartHook(), new WideContentExpandHook(), new SplitQuestionExpandHook(),
    new CrossPageExpandHook(), new HandwrittenStartHook(), new ExplanationFinalizeHook(), new CorrectionApplier(),
  );

const run = async (file: string): Promise<void> => {
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
      putObject: async () => undefined, figureKeyPrefix: 'ent', positionOffset: total, displayFlat: flat, displayMask: mask, displaySource: pages[i],
    } as any);
    const drafts: ShadowDraft[] = (vd as OcrEngineDraft[]).map((d, k) => ({
      index: total + k, page: i + 1, questionNumber: d.questionNumber ?? null, text: d.text ?? '', coords: d.sourceCoordinates,
    }));
    const words: ShadowWord[] = wb.map((w) => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }));
    total += vd.length;
    input.push({ pageImage: pages[i], pageIndex: i + 1, drafts, words });
  }
  await worker.terminate();

  const report = await buildAnalyzer().analyzePaper(input);
  const v = new EnterpriseValidator().validate(report);

  console.log(`\n================ ENTERPRISE VALIDATION — ${path.basename(file)} ================`);
  console.log(`   1. Total logical questions   : ${v.totalLogicalQuestions}`);
  console.log(`   2. Total emitted crops       : ${v.totalEmittedCrops}`);
  console.log(`   3. Missing questions         : ${v.missingQuestions}`);
  console.log(`   4. Duplicate crops (bad)     : ${v.duplicateQuestions}   (legitimate section-restart groups: ${v.legitimateDuplicateGroups})`);
  console.log(`   5. Orphan crops              : ${v.orphanCrops}`);
  console.log(`   6. Extra crops               : ${v.extraCrops}`);
  console.log(`   7. Q+Options completeness    : ${v.questionOptionsCompletePct}%`);
  console.log(`   8. Explanation leakage crops : ${v.explanationLeakageCrops}   (AFTER trim; residual = anti-aggressive safety skips → review)`);
  console.log(`   9. Review queue items        : ${v.reviewQueueItems}`);
  console.log(`  10. N → N verification        : ${v.nToN ? 'PASS ✅' : 'FAIL ❌'} (logical ${v.totalLogicalQuestions} = emitted ${v.totalEmittedCrops})`);
  console.log(`  11. Detector contributions:`);
  for (const c of v.detectorContributions) {
    console.log(`        ${c.detector.padEnd(24)} findings=${String(c.findings).padStart(3)} conf=[${c.confidenceMin ?? '-'}..${c.confidenceMax ?? '-'}] autofix=${c.autoFix} review=${c.review} observe=${c.observe} noop=${c.noOp}`);
  }
  console.log(`  ── ACCEPTANCE: ${v.acceptance.pass ? 'PASS ✅' : 'NOT YET ❌'}  ` +
    `{N→N:${v.acceptance.nToN} 1q=1crop:${v.acceptance.oneQuestionOneCrop} 0dup:${v.acceptance.zeroDuplicateCrops} ` +
    `0orphan:${v.acceptance.zeroOrphanCrops} 0extra:${v.acceptance.zeroExtraCrops} 0explan-leak:${v.acceptance.zeroExplanationLeakage}}`);
  if (v.acceptance.blockedByDeferredApplication.length) console.log(`     blocked by deferred application: ${v.acceptance.blockedByDeferredApplication.join('; ')}`);
};

const main = async (): Promise<void> => {
  for (const f of process.argv.slice(2)) { try { await run(f); } catch (e) { console.log(`\n==== ${path.basename(f)} ERROR: ${e instanceof Error ? e.message : String(e)}`); } }
};
main().catch((e) => { console.error(e); process.exit(1); });
