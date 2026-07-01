/* eslint-disable no-console */
/**
 * P0 split/cross-page fix tests. TEST 1-3 exercise the fixed detectors + applier directly (the only
 * way without real split PDFs); TEST 4-6 are real-PDF regression guards via the full pipeline.
 *   npx ts-node scripts/ocr-p0-tests.ts
 */
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { segmentVisualDrafts } from '../src/shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';
import type { OcrEngineDraft } from '../src/shared/ocr-engine/ocr-engine';
import { detectSplitOrphans } from '../src/modules/ocr-analysis/split-question';
import { detectCrossPageContinuations } from '../src/modules/ocr-analysis/cross-page';
import { CorrectionApplier } from '../src/modules/ocr-analysis/correction-applier';
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
import { ProductionBridge } from '../src/modules/ocr-analysis/production-bridge';
import { OcrShadowAnalyzer, PageInput } from '../src/modules/ocr-analysis/ocr-shadow-analyzer';
import type { PaperDetectorContext, ShadowDraft, ShadowWord } from '../src/modules/ocr-analysis/contracts';

const w = (text: string, x0: number, y0: number, x1: number, y1: number): ShadowWord => ({ text, x0, y0, x1, y1 });
const applier = new CorrectionApplier();
const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const record = (name: string, pass: boolean, detail: string) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}: ${detail}`); };

// ── TEST 1: Question left, Options right → must become 1 crop ──
const test1 = () => {
  const drafts: ShadowDraft[] = [
    { index: 0, page: 1, questionNumber: 1, text: '1. What is X', coords: { x0: 0, y0: 0, x1: 300, y1: 100 } },
    { index: 1, page: 1, questionNumber: 99, text: 'A) foo B) bar C) baz D) qux', coords: { x0: 320, y0: 0, x1: 620, y1: 100 } },
  ];
  const words: ShadowWord[] = [
    w('1.', 10, 10, 30, 30), w('What', 40, 10, 90, 30), w('is', 100, 10, 120, 30), w('X', 130, 10, 150, 30),
    w('A)', 330, 10, 355, 30), w('foo', 360, 10, 400, 30), w('B)', 420, 10, 445, 30), w('bar', 450, 10, 490, 30),
    w('C)', 330, 45, 355, 65), w('baz', 360, 45, 400, 65), w('D)', 420, 45, 445, 65), w('qux', 450, 45, 490, 65),
  ];
  const ctx: PaperDetectorContext = { drafts, pages: [], wordsByPage: [words] };
  const findings = detectSplitOrphans(ctx);
  const assoc = findings.filter((f) => f.kind === 'split-orphan-associable');
  const applied = applier.apply(drafts, [], assoc, []);
  record('TEST 1 (Q-left / options-right → 1 crop)', applied.drafts.length === 1 && applied.splitMerges === 1,
    `detected=${assoc.length} merges=${applied.splitMerges} finalCrops=${applied.drafts.length} (expect 1)`);
};

// ── TEST 2: Question page N, Options page N+1 → must become 1 crop ──
const test2 = () => {
  const drafts: ShadowDraft[] = [
    { index: 0, page: 1, questionNumber: 5, text: '5. Define Y', coords: { x0: 0, y0: 600, x1: 600, y1: 700 } },
    { index: 1, page: 2, questionNumber: null, text: 'A) a B) b C) c D) d', coords: { x0: 0, y0: 0, x1: 600, y1: 90 } },
  ];
  const p1: ShadowWord[] = [w('5.', 10, 610, 30, 630), w('Define', 40, 610, 110, 630), w('Y', 120, 610, 140, 630)];
  const p2: ShadowWord[] = [
    w('A)', 10, 10, 35, 30), w('a', 40, 10, 60, 30), w('B)', 120, 10, 145, 30), w('b', 150, 10, 170, 30),
    w('C)', 10, 45, 35, 65), w('c', 40, 45, 60, 65), w('D)', 120, 45, 145, 65), w('d', 150, 45, 170, 65),
  ];
  const ctx: PaperDetectorContext = { drafts, pages: [], wordsByPage: [p1, p2] };
  const findings = detectCrossPageContinuations(ctx);
  const applied = applier.apply(drafts, [], [], findings);
  record('TEST 2 (Q page N / options page N+1 → 1 crop)', applied.drafts.length === 1 && applied.crossPageMerges === 1,
    `detected=${findings.length} stitches=${applied.crossPageMerges} finalCrops=${applied.drafts.length} (expect 1)`);
};

// ── TEST 3: Question page N, Question page N+1 → must remain 2 crops ──
const test3 = () => {
  const drafts: ShadowDraft[] = [
    { index: 0, page: 1, questionNumber: 5, text: '5. Define Y A) a B) b C) c D) d', coords: { x0: 0, y0: 600, x1: 600, y1: 760 } },
    { index: 1, page: 2, questionNumber: 6, text: '6. What is Z A) p B) q C) r D) s', coords: { x0: 0, y0: 0, x1: 600, y1: 160 } },
  ];
  const p1: ShadowWord[] = [w('5.', 10, 610, 30, 630), w('Define', 40, 610, 110, 630), w('Y', 120, 610, 140, 630),
    w('A)', 10, 660, 35, 680), w('a', 40, 660, 60, 680), w('B)', 120, 660, 145, 680), w('b', 150, 660, 170, 680),
    w('C)', 10, 700, 35, 720), w('c', 40, 700, 60, 720), w('D)', 120, 700, 145, 720), w('d', 150, 700, 170, 720)];
  const p2: ShadowWord[] = [w('6.', 10, 10, 30, 30), w('What', 40, 10, 90, 30), w('is', 100, 10, 120, 30), w('Z', 130, 10, 150, 30),
    w('A)', 10, 60, 35, 80), w('p', 40, 60, 60, 80), w('B)', 120, 60, 145, 80), w('q', 150, 60, 170, 80),
    w('C)', 10, 100, 35, 120), w('r', 40, 100, 60, 120), w('D)', 120, 100, 145, 120), w('s', 150, 100, 170, 120)];
  const ctx: PaperDetectorContext = { drafts, pages: [], wordsByPage: [p1, p2] };
  const cross = detectCrossPageContinuations(ctx);
  const split = detectSplitOrphans(ctx);
  const applied = applier.apply(drafts, [], split.filter((f) => f.kind === 'split-orphan-associable'), cross);
  record('TEST 3 (Q page N / Q page N+1 → stays 2 crops)', applied.drafts.length === 2 && applied.crossPageMerges === 0 && applied.splitMerges === 0,
    `cross=${cross.length} split=${split.length} finalCrops=${applied.drafts.length} (expect 2)`);
};

const buildAnalyzer = (): OcrShadowAnalyzer =>
  new OcrShadowAnalyzer(new PageAnalyzer(), buildDetectors(), new ShadowIntegrityValidator(), new PaperAnalyzer(),
    new CountReconciler(), new ReviewQueueRouter(), new QuestionLifecycleEngine(), new MultiColumnStartHook(),
    new WideContentExpandHook(), new SplitQuestionExpandHook(), new CrossPageExpandHook(), new HandwrittenStartHook(),
    new ExplanationFinalizeHook(), new CorrectionApplier());
const collectWordBoxes = (d: any): OcrWordBox[] => {
  const out: OcrWordBox[] = [];
  for (const b of d?.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) for (const wd of l.words ?? []) {
    const t = (wd.text ?? '').trim(); if (!t || !wd.bbox) continue;
    const { x0, y0, x1, y1 } = wd.bbox; if ([x0, y0, x1, y1].some((v) => typeof v !== 'number')) continue;
    out.push({ text: t, x0, y0, x1, y1 });
  }
  return out;
};
const realGuard = async (name: string, file: string, expectedCount: number): Promise<void> => {
  const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(fs.readFileSync(file), { scale: 2 });
  const pages: Buffer[] = []; for await (const p of doc) pages.push(p as Buffer);
  const flat = await buildFlatField(pages); const mask = buildWatermarkMask(flat);
  const worker = await createWorker('eng'); const input: PageInput[] = []; let total = 0;
  for (let i = 0; i < pages.length; i += 1) {
    const clean = await cleanPageImage(pages[i], flat);
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    const wb = collectWordBoxes(data);
    const { drafts: vd } = await segmentVisualDrafts(clean, wb, i + 1, { putObject: async () => undefined, figureKeyPrefix: 'p0', positionOffset: total, displayFlat: flat, displayMask: mask, displaySource: pages[i] } as any);
    const drafts: ShadowDraft[] = (vd as OcrEngineDraft[]).map((d, k) => ({ index: total + k, page: i + 1, questionNumber: d.questionNumber ?? null, text: d.text ?? '', coords: d.sourceCoordinates }));
    const words: ShadowWord[] = wb.map((x) => ({ text: x.text, x0: x.x0, y0: x.y0, x1: x.x1, y1: x.y1 }));
    total += vd.length; input.push({ pageImage: pages[i], pageIndex: i + 1, drafts, words });
  }
  await worker.terminate();
  const report = await buildAnalyzer().analyzePaper(input);
  const b = new ProductionBridge().build(report);
  const pass = b.totalBridgeObjects === expectedCount && b.splitMergedObjects === 0 && b.crossPageMergedObjects === 0;
  record(name, pass, `crops=${b.totalBridgeObjects} (expect ${expectedCount}) falseSplitMerges=${b.splitMergedObjects} falseCrossMerges=${b.crossPageMergedObjects}`);
};

const main = async (): Promise<void> => {
  test1(); test2(); test3();
  await realGuard('TEST 4 (true multi-column → separate questions)', 'C:/Users/hp/Downloads/AD 2601 Q.pdf', 149);
  await realGuard('TEST 5 (match-the-following → untouched)', 'C:/Users/hp/Downloads/Biology_Cell.pdf', 92);
  await realGuard('TEST 6 (diagram-heavy → untouched)', 'C:/Users/hp/Downloads/Biology.pdf', 85);
  console.log(`\n==== RESULT: ${results.filter((r) => r.pass).length}/${results.length} PASS ====`);
  console.log(results.map((r) => `${r.pass ? '✅' : '❌'} ${r.name}`).join('\n'));
};
main().catch((e) => { console.error(e); process.exit(1); });
