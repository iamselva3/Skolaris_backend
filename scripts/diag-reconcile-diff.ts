/* eslint-disable no-console */
/**
 * READ-ONLY reconciliation diff harness (no engine/detector/delivery/architecture changes).
 *
 * Reproduces the EXACT wired runner path on a real PDF and proves, per logical question, where (if
 * anywhere) the delivered set diverges from the raw engine segmentation:
 *
 *   Engine drafts ──► analyzePaper (Reconciliation) ──► N=N gate ──► delivery.deliver (Delivered)
 *
 * It answers the investigation questions with EVIDENCE:
 *   1. Is reconciliation dropping drafts?            → removed indices + reason
 *   2. Is reconciliation merging unrelated drafts?   → split/cross-page member sets
 *   3. Is N=N being bypassed?                        → deliverable flag vs delivered length
 *   4. Which drafts are mutated?                     → per-draft DROP/MERGE/TRIM/KEEP
 *   5. Which step introduces the mismatch?           → engine vs finalLogicalCount vs delivered
 *   6. Is the engine output already correct?         → engine per-Q crop counts
 *   7. Engine count vs reconciliation count vs delivered count
 *   8. Per-question diff: Engine Qn → Reconciliation Qn → Delivered Qn
 *
 *   npx ts-node scripts/diag-reconcile-diff.ts "<pdf>"
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
import { OcrShadowAnalyzer, PageInput } from '../src/modules/ocr-analysis/ocr-shadow-analyzer';
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
import type { ShadowDraft, ShadowWord, BBox } from '../src/modules/ocr-analysis/contracts';

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

const toBBox = (c: any): BBox | undefined =>
  c && [c.x0, c.y0, c.x1, c.y1].every((v: any) => typeof v === 'number') ? { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 } : undefined;

const run = async (file: string): Promise<void> => {
  if (!fs.existsSync(file)) { console.error(`PDF not found: ${file}`); process.exit(2); }
  const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(fs.readFileSync(file), { scale: 2 });
  const pages: Buffer[] = []; for await (const p of doc) pages.push(p as Buffer);
  const flat = await buildFlatField(pages); const mask = buildWatermarkMask(flat);
  const store = new Map<string, Buffer>();
  const putObject = async (key: string, body: Buffer) => { store.set(key, body); };
  const worker = await createWorker('eng');

  // ── STAGE 1: ENGINE (exact production segmentation) ─────────────────────────
  const wordsByPage: ShadowWord[][] = [];
  const base: OcrEngineDraft[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    const clean = await cleanPageImage(pages[i], flat);
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    const wb = collectWordBoxes(data);
    const displayPage = await cleanPageForDisplay(pages[i], flat, mask, wb);
    const { drafts: vd } = await segmentVisualDrafts(clean, wb, i + 1, { putObject, figureKeyPrefix: 'tenants/t/ocr-figures/job', positionOffset: base.length, displayFlat: flat, displayMask: mask, displaySource: displayPage } as any);
    base.push(...(vd as OcrEngineDraft[]));
    wordsByPage[i] = wb.map((x) => ({ text: x.text, x0: x.x0, y0: x.y0, x1: x.x1, y1: x.y1 }));
  }
  await worker.terminate();

  // ── STAGE 2: RECONCILIATION internals (analyzePaper directly) ───────────────
  const analyzer = buildAnalyzer();
  const byPage = new Map<number, Array<{ d: OcrEngineDraft; index: number }>>();
  base.forEach((d, index) => { const pg = d.sourcePageNumber ?? 1; (byPage.get(pg) ?? byPage.set(pg, []).get(pg)!).push({ d, index }); });
  const pageInputs: PageInput[] = [];
  for (let p = 1; p <= pages.length; p += 1) {
    const entries = byPage.get(p) ?? [];
    const shadow: ShadowDraft[] = entries.map(({ d, index }) => ({ index, page: p, questionNumber: d.questionNumber ?? null, text: d.text ?? '', coords: toBBox(d.sourceCoordinates) }));
    pageInputs.push({ pageImage: pages[p - 1], pageIndex: p, drafts: shadow, words: wordsByPage[p - 1] ?? [] });
  }
  const report: any = await analyzer.analyzePaper(pageInputs);
  const emitted: any[] = (report.lifecycle ?? []).filter((l: any) => l.emittedCrop);
  const keptIdx = new Set<number>(emitted.map((l) => l.draftIndex));
  const provByIdx = new Map<number, any>((report.appliedProvenance ?? []).map((pr: any) => [pr.draftIndex, pr]));
  const finalLogicalCount = report.reconciliation?.finalLogicalCount ?? emitted.length;

  // ── STAGE 3: DELIVERY (exact wired adapter) ─────────────────────────────────
  const delivery = new OcrAnalysisDeliveryService(analyzer);
  const result = await delivery.deliver(base as unknown as DeliverableDraft[], { wordsByPage, pageImages: pages }, {
    getObject: async (k) => store.get(k) ?? Buffer.alloc(0), putObject, figureKeyPrefix: 'tenants/t/ocr-figures/job/merged',
  });
  const final = result.drafts as unknown as OcrEngineDraft[];

  // ── COUNTS (Q5/Q6/Q7) ───────────────────────────────────────────────────────
  console.log(`\n================= RECONCILE DIFF — ${path.basename(file)} (${pages.length} page(s)) =================`);
  console.log(`flatField=${flat ? `${flat.width}x${flat.height}` : 'NONE (<3 pages → no cross-page consensus)'} watermarkMask=${mask ? 'built' : 'none'}`);
  console.log(`\n[Q7] COUNTS:  engineDrafts=${base.length}   reconciliation.finalLogicalCount=${finalLogicalCount}   emittedKept=${keptIdx.size}   delivered=${final.length}`);
  console.log(`[Q1] removed (dropped/absorbed) = ${result.removed}`);
  console.log(`[Q2] splitMerged = ${result.splitMerged}   crossPageMerged = ${result.crossPageMerged}   trimmedCrops = ${result.trimmedCrops}`);
  console.log(`[Q3] N=N gate: deliverable=${result.deliverable}  (delivered=${final.length} vs finalLogicalCount=${finalLogicalCount})`);
  console.log(`     ↳ wired runner IGNORES this flag and persists the delivered set REGARDLESS → bypass=${result.deliverable === false ? 'YES (would ship a wrong set)' : 'no (set agrees this run)'}`);

  // ── PER-DRAFT MUTATION MAP (Q4) ─────────────────────────────────────────────
  console.log(`\n[Q4] PER-ENGINE-DRAFT MUTATION:`);
  console.log(`idx | page | engineQ# | outcome`);
  for (let i = 0; i < base.length; i += 1) {
    const d = base[i];
    const prov = provByIdx.get(i);
    let outcome: string;
    if (!keptIdx.has(i)) {
      const absorbed = (report.appliedProvenance ?? []).some((pr: any) => keptIdx.has(pr.draftIndex) && (pr.mergedRegions?.length ?? 0) > 1);
      outcome = `DROPPED${prov?.reason ? ` (${prov.reason})` : absorbed ? ' (absorbed into a merge)' : ' (not emitted by lifecycle)'}`;
    } else if (prov && (prov.mergedRegions?.length ?? 0) > 1) {
      outcome = `MERGED survivor (regions=${prov.mergedRegions.length}, pages=${prov.sourcePages?.length ?? 1})`;
    } else if (prov && typeof prov.trimmedToY === 'number') {
      outcome = `TRIMMED (re-crop to y=${prov.trimmedToY})`;
    } else {
      outcome = 'KEPT (byte-identical)';
    }
    if (!outcome.startsWith('KEPT')) console.log(`${i} | ${d.sourcePageNumber ?? '?'} | ${d.questionNumber ?? '—'} | ${outcome}`);
  }
  const keptCount = base.filter((_, i) => keptIdx.has(i) && !((provByIdx.get(i)?.mergedRegions?.length ?? 0) > 1) && typeof provByIdx.get(i)?.trimmedToY !== 'number').length;
  console.log(`(KEPT byte-identical: ${keptCount} drafts not listed)`);

  // ── PER-QUESTION DIFF (Q8): Engine Qn → Reconciliation Qn → Delivered Qn ─────
  const engByNum = new Map<number, number>();
  for (const d of base) { const n = d.questionNumber ?? -1; engByNum.set(n, (engByNum.get(n) ?? 0) + 1); }
  const finByNum = new Map<number, number>();
  for (const d of final) { const n = d.questionNumber ?? -1; finByNum.set(n, (finByNum.get(n) ?? 0) + 1); }
  const allNums = [...new Set([...engByNum.keys(), ...finByNum.keys()])].filter((n) => n >= 0).sort((a, b) => a - b);
  console.log(`\n[Q8] PER-QUESTION DIFF (only rows where Engine≠Delivered shown):`);
  console.log(`Q# | engineCrops | deliveredCrops | verdict`);
  let mutated = 0;
  for (const n of allNums) {
    const e = engByNum.get(n) ?? 0; const f = finByNum.get(n) ?? 0;
    if (e === f && e === 1) continue;
    mutated += 1;
    const verdict = f === 0 ? 'LOST (question vanished)' : f < e ? 'merged/reduced' : f > e ? 'duplicated' : (e !== 1 ? 'engine already multi-crop' : 'ok');
    console.log(`Q${n} | ${e} | ${f} | ${verdict}`);
  }
  if (mutated === 0) console.log(`  (none — Engine and Delivered agree 1:1 on every numbered question for THIS pdf)`);

  // ── Q6 verdict ──────────────────────────────────────────────────────────────
  const engNoNumber = base.filter((d) => (d.questionNumber ?? null) === null).length;
  console.log(`\n[Q6] Engine output: ${base.length} crops, ${engByNum.size} distinct Q#, ${engNoNumber} with no detected number.`);
  console.log(`\nVERDICT: engine→delivered net change = ${final.length - base.length} crops; mutated questions = ${mutated}; N=N holds = ${result.deliverable}.`);
};
run(process.argv[2] ?? 'fixtures/sample-paper.pdf').catch((e) => { console.error(e); process.exit(1); });
