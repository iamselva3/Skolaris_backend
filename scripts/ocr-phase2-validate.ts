/* eslint-disable no-console */
/**
 * PHASE 2 validation — Content-Numeral detector (the only ACTIVE detector). Runs the UNCHANGED OCR
 * engine read-only, then the framework's paper-level pass, and reports per PDF:
 *   ocrDrafts → correctedDrafts, expectedQuestionCount, sections, autoFixed (HIGH), reviewQueue (MED).
 *
 * Regression gate: clean papers (RE NEET PST, Biology) must have ZERO auto-fixes and ZERO review
 * findings ⇒ corrected == ocr ⇒ IDENTICAL. AD residual sign-prefixed units should auto-fix.
 *
 *   npx ts-node scripts/ocr-phase2-validate.ts "<pdf>" ["<pdf>" ...]
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

const CLEAN = new Set(['RE NEET PST 3 (1)-1-4.pdf', 'Biology.pdf']);

const run = async (file: string): Promise<void> => {
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(fs.readFileSync(file), { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  const flat = await buildFlatField(pages);
  const mask = buildWatermarkMask(flat);
  const analyzer = new OcrShadowAnalyzer(new PageAnalyzer(), buildDetectors(), new ShadowIntegrityValidator(), new PaperAnalyzer(), new CountReconciler(), new ReviewQueueRouter(), new QuestionLifecycleEngine(), new MultiColumnStartHook(), new WideContentExpandHook(), new SplitQuestionExpandHook(), new CrossPageExpandHook(), new HandwrittenStartHook(), new ExplanationFinalizeHook(), new CorrectionApplier());

  const worker = await createWorker('eng');
  const input: PageInput[] = [];
  let total = 0;
  for (let i = 0; i < pages.length; i += 1) {
    const clean = await cleanPageImage(pages[i], flat);
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    const wb = collectWordBoxes(data);
    const { drafts: vd } = await segmentVisualDrafts(clean, wb, i + 1, {
      putObject: async () => undefined, figureKeyPrefix: 'p2', positionOffset: total, displayFlat: flat, displayMask: mask, displaySource: pages[i],
    } as any);
    const drafts: ShadowDraft[] = (vd as OcrEngineDraft[]).map((d, k) => ({
      index: total + k, page: i + 1, questionNumber: d.questionNumber ?? null, text: d.text ?? '', coords: d.sourceCoordinates,
    }));
    const words: ShadowWord[] = wb.map((w) => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }));
    total += vd.length;
    input.push({ pageImage: pages[i], pageIndex: i + 1, drafts, words });
  }
  await worker.terminate();

  const r = await analyzer.analyzePaper(input);
  const isClean = CLEAN.has(path.basename(file));
  const identical = r.ocrDraftCount === r.correctedDraftCount && r.autoFixed.length === 0 && r.routedReview.length === 0;
  const emitOk = r.emittedCount === r.reconciliation.finalLogicalCount;
  console.log(`\n==== ${path.basename(file)} ====`);
  console.log(`  OCR drafts            : ${r.ocrDraftCount}`);
  console.log(`  Corrected drafts      : ${r.correctedDraftCount}`);
  console.log(`  Expected (structure)  : ${r.structure.expectedQuestionCount}  (sections=${r.structure.sections.length})`);
  console.log(`  RECONCILIATION        : final=${r.reconciliation.finalLogicalCount} status=${r.reconciliation.status}  | ${r.reconciliation.notes.join('; ')}`);
  console.log(`  AUTO-FIX (HIGH)       : ${r.autoFixed.length}${r.autoFixed.length ? '  → ' + r.autoFixed.map((f) => `${f.kind}(Q${(f.evidence as any).questionNumber ?? (f.evidence as any).value})`).join(', ') : ''}`);
  console.log(`  REVIEW QUEUE (routed) : ${r.routedReview.length}${r.routedReview.length ? '  → ' + r.routedReview.map((f) => `${f.reason}:${f.detector}`).join(', ') : ''}`);
  const withBoundary = r.completionBoundaries.filter((b) => b.completeAtY !== null).length;
  console.log(`  COMPLETION BOUNDARIES : ${withBoundary}/${r.completionBoundaries.length} drafts (boundary source ready for Explanation prep)`);
  const allEmitted = r.lifecycle.every((l) => l.emitted) && r.lifecycle.every((l) => l.stages.length === 5);
  console.log(`  LIFECYCLE / EMIT      : emitted=${r.emittedCount} (== final ${emitOk ? '✅' : '❌'}) ; all START→…→EMIT=${allEmitted ? '✅' : '❌'} ; flaggedReview=${r.lifecycle.filter((l) => l.needsReview).length}`);
  // START changed? compare each lifecycle's start region to its original draft coords (must be 0 — NO-OP geometry)
  const draftByIdx = new Map(input.flatMap((p) => p.drafts).map((d) => [d.index, d.coords]));
  const startChanged = r.lifecycle.filter((l) => { const c = draftByIdx.get(l.draftIndex); const s = l.startRegion; return !!c && !!s && (c.x0 !== s.x0 || c.x1 !== s.x1 || c.y0 !== s.y0 || c.y1 !== s.y1); }).length;
  const mcPages = new Set(r.observations.filter((f) => f.kind === 'multi-column-page').map((f) => f.target.page)).size;
  console.log(`  MULTI-COLUMN          : detected pages=${mcPages} (observations) ; START-region changed=${startChanged} (must be 0 — NO-OP geometry)`);
  const expandChanged = r.lifecycle.filter((l) => { const c = draftByIdx.get(l.draftIndex); const e = l.expandedRegion; return !!c && !!e && (c.x0 !== e.x0 || c.x1 !== e.x1 || c.y0 !== e.y0 || c.y1 !== e.y1); }).length;
  const wide = r.observations.filter((f) => f.kind.startsWith('wide:'));
  const wideByType = wide.reduce<Record<string, number>>((m, f) => { const t = (f.evidence as any).type; m[t] = (m[t] ?? 0) + 1; return m; }, {});
  console.log(`  WIDE CONTENT          : observations=${wide.length} ${JSON.stringify(wideByType)} ; EXPAND-region changed=${expandChanged} (must be 0 — NO-OP geometry)`);
  const split = r.routedReview.filter((f) => f.detector === 'split-question-options');
  console.log(`  SPLIT Q+OPTIONS       : orphan findings=${split.length} (review; 0 merges applied — counts unchanged)`);
  const xpage = r.routedReview.filter((f) => f.detector === 'cross-page-continuation');
  console.log(`  CROSS-PAGE            : continuation candidates=${xpage.length} (review; 0 stitches applied — counts unchanged)`);
  const hw = r.routedReview.filter((f) => f.detector === 'handwritten-markers');
  console.log(`  HANDWRITTEN MARKERS   : unmarked-boundary candidates=${hw.length} (review; 0 questions created — counts unchanged)`);
  const expl = r.observations.filter((f) => f.detector === 'explanation-blocks');
  const finalizeChanged = r.lifecycle.filter((l) => { const c = draftByIdx.get(l.draftIndex); const e = l.emittedCrop; return !!c && !!e && (c.x0 !== e.x0 || c.x1 !== e.x1 || c.y0 !== e.y0 || c.y1 !== e.y1); }).length;
  console.log(`  EXPLANATION BLOCKS    : observations=${expl.length} (FINALIZE hint) ; FINALIZE/emit-crop changed=${finalizeChanged} (must be 0 — 0 trims)`);
  if (isClean) console.log(`  CLEAN-PAPER REGRESSION: ${identical && emitOk && startChanged === 0 && expandChanged === 0 && finalizeChanged === 0 ? 'IDENTICAL ✅ (0 fixes, 0 review, N→N, 0 START/EXPAND/FINALIZE change)' : '*** REGRESSION ❌ ***'}`);
};

const main = async (): Promise<void> => {
  for (const f of process.argv.slice(2)) { try { await run(f); } catch (e) { console.log(`\n==== ${path.basename(f)} ERROR: ${e instanceof Error ? e.message : String(e)}`); } }
};
main().catch((e) => { console.error(e); process.exit(1); });
