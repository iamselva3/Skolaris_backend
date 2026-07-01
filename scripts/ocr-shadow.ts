/* eslint-disable no-console */
/**
 * SHADOW-MODE demonstration of the Phase-1 OCR analysis framework. Renders a PDF, runs the
 * UNCHANGED OCR engine read-only to obtain drafts + words, then runs the shadow analyzer
 * (Page Analyzer → 8 stub detectors → integrity validator) and prints the observability report.
 *
 * Proves the framework executes, collects findings, emits confidence + logs — and applies
 * NOTHING (report.applied === 0; OCR output untouched). This script is NOT part of the live flow.
 *
 *   npx ts-node scripts/ocr-shadow.ts "<pdf>"
 */
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { segmentVisualDrafts } from '../src/shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';
import type { OcrEngineDraft } from '../src/shared/ocr-engine/ocr-engine';
import { PageAnalyzer } from '../src/modules/ocr-analysis/page-analyzer';
import { buildDetectors } from '../src/modules/ocr-analysis/detectors';
import { ShadowIntegrityValidator } from '../src/modules/ocr-analysis/integrity-validator';
import { PaperAnalyzer } from '../src/modules/ocr-analysis/paper-analyzer';
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
import { OcrShadowAnalyzer } from '../src/modules/ocr-analysis/ocr-shadow-analyzer';
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

const main = async (): Promise<void> => {
  const file = process.argv[2];
  if (!file) throw new Error('usage: ocr-shadow.ts <pdf>');
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(fs.readFileSync(file), { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  const flat = await buildFlatField(pages);
  const mask = buildWatermarkMask(flat);

  // assemble the framework exactly as the Nest module would
  const analyzer = new OcrShadowAnalyzer(new PageAnalyzer(), buildDetectors(), new ShadowIntegrityValidator(), new PaperAnalyzer(), new CountReconciler(), new ReviewQueueRouter(), new QuestionLifecycleEngine(), new MultiColumnStartHook(), new WideContentExpandHook(), new SplitQuestionExpandHook(), new CrossPageExpandHook(), new HandwrittenStartHook(), new ExplanationFinalizeHook(), new CorrectionApplier());

  const worker = await createWorker('eng');
  let totalDrafts = 0;
  let totalFindings = 0;
  let totalApplied = 0;
  for (let i = 0; i < pages.length; i += 1) {
    const clean = await cleanPageImage(pages[i], flat);
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    const wb = collectWordBoxes(data);
    const { drafts: vd } = await segmentVisualDrafts(clean, wb, i + 1, {
      putObject: async () => undefined, figureKeyPrefix: 'shadow', positionOffset: totalDrafts, displayFlat: flat, displayMask: mask, displaySource: pages[i],
    } as any);
    const drafts: ShadowDraft[] = (vd as OcrEngineDraft[]).map((d, k) => ({
      index: totalDrafts + k, page: i + 1, questionNumber: d.questionNumber ?? null, text: d.text ?? '', coords: d.sourceCoordinates,
    }));
    const words: ShadowWord[] = wb.map((w) => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }));
    totalDrafts += vd.length;

    const report = await analyzer.analyzePage(pages[i], i + 1, drafts, words);
    totalFindings += report.findings.length;
    totalApplied += report.applied;
    console.log(
      `p${i + 1}: density=${report.featuresSummary.textDensity} gutters=${report.featuresSummary.gutters} ` +
        `numerals=${report.featuresSummary.numerals} drafts=${report.featuresSummary.drafts} ` +
        `findings=${report.findings.length} applied=${report.applied}`,
    );
  }
  await worker.terminate();
  console.log(`\n==== ${path.basename(file)} — SHADOW SUMMARY ====`);
  console.log(`  drafts=${totalDrafts}  findings=${totalFindings}  APPLIED=${totalApplied}  (expect findings=0 & applied=0 in Phase 1)`);
  console.log(`  OCR output untouched ✅ (framework is observability-only, not wired into the flow)`);
};

main().catch((e) => { console.error(e); process.exit(1); });
