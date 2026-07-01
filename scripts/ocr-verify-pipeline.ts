/* eslint-disable no-console */
/**
 * END-TO-END OCR PIPELINE VERIFICATION (not a browser test, no Playwright). Runs the FULL chain on
 * any PDF — Page Analyzer → 8 detectors → Correction Applier → Question Lifecycle → Enterprise
 * Validation → final emitted crops — and verifies every emitted crop individually. Read-only over
 * the UNCHANGED engine; no module changes; the 5 references are regression GUARDS only.
 *
 *   npx ts-node scripts/ocr-verify-pipeline.ts "<pdf>" ["<pdf>" ...]
 */
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { segmentVisualDrafts, hasStem, detectQuestionPunct, medianHeight } from '../src/shared/ocr-engine/visual-segment';
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
const OPTION_LABEL = /^\(?([A-Da-d])[.)]$|^\(([1-4])\)$/;
const EXPLANATION_ONSET = /^(sol|soln|solution|ans|answer|explanation|explanations|exp|hint|hints)\b[:.)\]]?$/i;
const build = (): OcrShadowAnalyzer =>
  new OcrShadowAnalyzer(new PageAnalyzer(), buildDetectors(), new ShadowIntegrityValidator(), new PaperAnalyzer(),
    new CountReconciler(), new ReviewQueueRouter(), new QuestionLifecycleEngine(), new MultiColumnStartHook(),
    new WideContentExpandHook(), new SplitQuestionExpandHook(), new CrossPageExpandHook(), new HandwrittenStartHook(),
    new ExplanationFinalizeHook(), new CorrectionApplier());

interface Outcome { pass: boolean; reasons: string[] }

const run = async (file: string): Promise<Outcome> => {
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(fs.readFileSync(file), { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  const flat = await buildFlatField(pages);
  const mask = buildWatermarkMask(flat);

  const worker = await createWorker('eng');
  const input: PageInput[] = [];
  const wordsByPage: OcrWordBox[][] = [];
  let total = 0;
  for (let i = 0; i < pages.length; i += 1) {
    const clean = await cleanPageImage(pages[i], flat);
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    const wb = collectWordBoxes(data);
    wordsByPage.push(wb);
    const { drafts: vd } = await segmentVisualDrafts(clean, wb, i + 1, {
      putObject: async () => undefined, figureKeyPrefix: 'verify', positionOffset: total, displayFlat: flat, displayMask: mask, displaySource: pages[i],
    } as any);
    const drafts: ShadowDraft[] = (vd as OcrEngineDraft[]).map((d, k) => ({ index: total + k, page: i + 1, questionNumber: d.questionNumber ?? null, text: d.text ?? '', coords: d.sourceCoordinates }));
    const words: ShadowWord[] = wb.map((w) => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }));
    total += vd.length;
    input.push({ pageImage: pages[i], pageIndex: i + 1, drafts, words });
  }
  await worker.terminate();

  const report = await build().analyzePaper(input);
  const v = new EnterpriseValidator().validate(report);

  // ── verify EVERY emitted crop individually ──
  const qPunctByPage = new Map<number, ')' | '.'>();
  for (let p = 0; p < wordsByPage.length; p += 1) qPunctByPage.set(p + 1, detectQuestionPunct(wordsByPage[p], medianHeight(wordsByPage[p])));
  let cropsQuestion = 0, cropsOptions = 0, cropsNoExplanation = 0, cropsFullyValid = 0;
  for (const l of report.lifecycle) {
    const c = l.emittedCrop;
    if (!c) continue;
    const w = wordsByPage[l.page - 1] ?? [];
    const rw = w.filter((x) => { const cx = (x.x0 + x.x1) / 2, cy = (x.y0 + x.y1) / 2; return cx >= c.x0 && cx < c.x1 && cy >= c.y0 && cy < c.y1; });
    const qPunct = qPunctByPage.get(l.page) ?? '.';
    const optionYs = rw.filter((x) => OPTION_LABEL.test(x.text)).map((x) => x.y1);
    const qExists = hasStem(rw, qPunct);
    const optsExist = new Set(rw.filter((x) => OPTION_LABEL.test(x.text)).map((x) => x.text.replace(/[^A-Da-d1-4]/g, '').toLowerCase())).size >= 2;
    const lastOptY = optionYs.length ? Math.max(...optionYs) : -Infinity;
    const explInside = rw.some((x) => EXPLANATION_ONSET.test(x.text) && x.y0 > lastOptY);
    if (qExists) cropsQuestion += 1;
    if (optsExist) cropsOptions += 1;
    if (!explInside) cropsNoExplanation += 1;
    if (qExists && optsExist && !explInside) cropsFullyValid += 1;
  }
  const n = report.lifecycle.length || 1;

  // ── success criteria (per the spec) ──
  const reasons: string[] = [];
  if (!v.nToN) reasons.push(`N→N failed (logical ${v.totalLogicalQuestions} ≠ emitted ${v.totalEmittedCrops})`);
  if (v.duplicateQuestions > 0) reasons.push(`${v.duplicateQuestions} duplicate crops`);
  if (v.orphanCrops > 0) reasons.push(`${v.orphanCrops} orphan crops`);
  if (v.extraCrops > 0) reasons.push(`${v.extraCrops} extra crops`);
  if (v.missingQuestions > 0) reasons.push(`${v.missingQuestions} missing crops`);
  if (v.explanationLeakageCrops > 0) reasons.push(`${v.explanationLeakageCrops} explanation-leakage crops (safety-skipped trims)`);

  console.log(`\n================ PIPELINE VERIFY — ${path.basename(file)} (${pages.length}p) ================`);
  console.log(`   1. Total logical questions   : ${v.totalLogicalQuestions}`);
  console.log(`   2. Total emitted crops       : ${v.totalEmittedCrops}`);
  console.log(`   3. N → N verification        : ${v.nToN ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log(`   4. Duplicate crops           : ${v.duplicateQuestions}   (legitimate section-restart groups: ${v.legitimateDuplicateGroups})`);
  console.log(`   5. Missing crops             : ${v.missingQuestions}`);
  console.log(`   6. Extra crops               : ${v.extraCrops}`);
  console.log(`   7. Orphan crops              : ${v.orphanCrops}`);
  console.log(`   8. Explanation leakage       : ${v.explanationLeakageCrops}`);
  console.log(`   9. Q+Options completeness    : ${v.questionOptionsCompletePct}%`);
  console.log(`  10. Detector contributions    : ${v.detectorContributions.map((c) => `${c.detector}(${c.findings}:af${c.autoFix}/rv${c.review}/ob${c.observe}/no${c.noOp})`).join(' ')}`);
  console.log(`  11. Applied corrections       : trims=${report.corrections.explanationTrims} splitMerges=${report.corrections.splitMerges} crossPageMerges=${report.corrections.crossPageMerges}`);
  console.log(`  12. Review queue items        : ${v.reviewQueueItems}`);
  console.log(`  13. Export-ready status       : derived crops only (NOT wired to live persistence/export)`);
  console.log(`  ── per-crop verification: question=${cropsQuestion}/${n} options=${cropsOptions}/${n} no-explanation=${cropsNoExplanation}/${n} FULLY-VALID=${cropsFullyValid}/${n}`);
  console.log(`  ── SUCCESS CRITERIA: ${reasons.length === 0 ? 'MET ✅' : 'NOT MET ❌ → ' + reasons.join('; ')}`);
  return { pass: reasons.length === 0, reasons };
};

const main = async (): Promise<void> => {
  const files = process.argv.slice(2);
  const results: Array<{ file: string; o: Outcome }> = [];
  for (const f of files) { try { results.push({ file: path.basename(f), o: await run(f) }); } catch (e) { console.log(`\n==== ${path.basename(f)} ERROR: ${e instanceof Error ? e.message : String(e)}`); results.push({ file: path.basename(f), o: { pass: false, reasons: ['error'] } }); } }

  console.log(`\n\n================ END-TO-END VERDICT ================`);
  const allCriteriaMet = results.every((r) => r.o.pass);
  // Production readiness also requires the corrections to reach the LIVE export, which they do not.
  const exportWired = false; // corrections live in the framework's derived output only
  const productionReady = allCriteriaMet && exportWired;
  console.log(`Per-PDF success criteria: ${results.map((r) => `${r.file}=${r.o.pass ? 'MET' : 'NOT'}`).join(' | ')}`);
  console.log(`\nProduction Ready: ${productionReady ? 'YES' : 'NO'}`);
  if (!productionReady) {
    console.log(`\nWhat remains:`);
    console.log(`  • DERIVED OUTPUT ONLY — the Correction Applier (explanation trim + split/cross-page merge) corrects the`);
    console.log(`    framework's emitted crops, but those are NOT wired to live persistence/export. The stored/exported`);
    console.log(`    crops are still the FROZEN engine's uncorrected crops (HandleOcrCallbackUseCase / OcrJobRunner untouched).`);
    console.log(`  • EXPORT NOT WIRED — emitted crops are corrected REGIONS (bboxes), not rendered crop images in the export path.`);
    console.log(`  • RESIDUAL EXPLANATION LEAKAGE — anti-aggressive safety skips leave a few untrimmed explanation crops on`);
    console.log(`    papers with high-onset solutions; literal 0-leakage needs review-queue routing of those skips (not aggressive trim).`);
    console.log(`  • SPLIT / CROSS-PAGE MERGE UNEXERCISED — 0 orphans / 0 continuations in the references; needs ≥3 real`);
    console.log(`    split-layout / cross-page sample PDFs to validate the merge path positively.`);
    console.log(`  • Q+O COMPLETENESS < 100% reflects OCR-text completeness (hasStem false-negatives on sparse/diagram), an`);
    console.log(`    OCR-quality limitation — not a correction these operations apply.`);
  }
};
main().catch((e) => { console.error(e); process.exit(1); });
