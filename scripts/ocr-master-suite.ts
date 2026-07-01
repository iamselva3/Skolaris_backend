/* eslint-disable no-console */
/**
 * MASTER SCENARIO TEST SUITE (35 cases). Each case is driven through the REAL full stack
 * (PageAnalyzer → 8 detectors → CorrectionApplier → QuestionLifecycle → validation → bridge) via
 * OcrAnalysisDeliveryService.deliver — the exact production wire. Layouts 1–30 are constructed as
 * engine-shaped drafts+words (no real PDF exhibits all 30); 31–35 run on real PDFs. The ONLY metric
 * is FINAL CLIENT OUTPUT: emitted crop count + trim of trailing blocks + no false merges.
 *   npx ts-node scripts/ocr-master-suite.ts
 */
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
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
import type { ShadowDraft, ShadowWord } from '../src/modules/ocr-analysis/contracts';

const PW = 1200; const PH = 1700;
const analyzer = (): OcrShadowAnalyzer =>
  new OcrShadowAnalyzer(new PageAnalyzer(), buildDetectors(), new ShadowIntegrityValidator(), new PaperAnalyzer(),
    new CountReconciler(), new ReviewQueueRouter(), new QuestionLifecycleEngine(), new MultiColumnStartHook(),
    new WideContentExpandHook(), new SplitQuestionExpandHook(), new CrossPageExpandHook(), new HandwrittenStartHook(),
    new ExplanationFinalizeHook(), new CorrectionApplier());
const delivery = new OcrAnalysisDeliveryService(analyzer());

let whitePng: Buffer;
const W = (t: string, x0: number, y0: number, x1: number, y1: number): ShadowWord => ({ text: t, x0, y0, x1, y1 });
// a stem (numbered) — ≥2 non-marker words ⇒ hasStem true, no option labels ⇒ MISSING options
const stem = (n: number | string, x0: number, y0: number): ShadowWord[] =>
  [W(`${n}.`, x0 + 2, y0, x0 + 32, y0 + 28), W('What', x0 + 38, y0, x0 + 120, y0 + 28), W('is', x0 + 126, y0, x0 + 160, y0 + 28), W('the', x0 + 166, y0, x0 + 220, y0 + 28), W('value', x0 + 226, y0, x0 + 330, y0 + 28)];
const stemCont = (x0: number, y0: number): ShadowWord[] => // lowercase continuation, no number, no options
  [W('of', x0, y0, x0 + 40, y0 + 28), W('the', x0 + 45, y0, x0 + 100, y0 + 28), W('given', x0 + 105, y0, x0 + 200, y0 + 28), W('quantity', x0 + 205, y0, x0 + 340, y0 + 28)];
const opts = (x0: number, y0: number): ShadowWord[] =>
  [W('A)', x0, y0, x0 + 28, y0 + 24), W('alpha', x0 + 32, y0, x0 + 120, y0 + 24), W('B)', x0, y0 + 32, x0 + 28, y0 + 56), W('beta', x0 + 32, y0 + 32, x0 + 120, y0 + 56), W('C)', x0, y0 + 64, x0 + 28, y0 + 88), W('gamma', x0 + 32, y0 + 64, x0 + 140, y0 + 88), W('D)', x0, y0 + 96, x0 + 28, y0 + 120), W('delta', x0 + 32, y0 + 96, x0 + 140, y0 + 120)];
const trail = (lead: string, x0: number, y0: number): ShadowWord[] => // trailing solution/answer/explanation/hint block
  [W(lead, x0, y0, x0 + 70, y0 + 24), W('therefore', x0 + 76, y0, x0 + 200, y0 + 24), W('the', x0 + 206, y0, x0 + 250, y0 + 24), W('result', x0 + 256, y0, x0 + 350, y0 + 24)];
const D = (index: number, page: number, qnum: number | null, text: string, x0: number, y0: number, x1: number, y1: number): ShadowDraft =>
  ({ index, page, questionNumber: qnum, text, coords: { x0, y0, x1, y1 } });

const results: Array<{ id: string; pass: boolean; detail: string }> = [];
const io = (store: Map<string, Buffer>) => ({
  getObject: async (k: string) => store.get(k) ?? whitePng,
  putObject: async (k: string, b: Buffer) => { store.set(k, b); },
  figureKeyPrefix: 'tenants/t/ocr-figures/job/x',
});

// run a synthetic case → return delivery result
const runCase = async (pages: PageInput[]): Promise<Awaited<ReturnType<typeof delivery.deliver>>> => {
  const drafts: DeliverableDraft[] = pages.flatMap((p) => p.drafts.map((d) => ({
    position: d.index, text: d.text, questionNumber: d.questionNumber, sourcePageNumber: d.page,
    sourceCoordinates: d.coords ?? null, questionSnapshotKey: `tenants/t/ocr-figures/job/q-${d.index}.png`, optionCount: 4,
  })));
  const store = new Map<string, Buffer>();
  for (const d of drafts) store.set(d.questionSnapshotKey as string, whitePng);
  return delivery.deliver(drafts, { wordsByPage: pages.map((p) => p.words), pageImages: pages.map((p) => p.pageImage) }, io(store));
};
const P = (pageIndex: number, drafts: ShadowDraft[], words: ShadowWord[]): PageInput => ({ pageImage: whitePng, pageIndex, drafts, words });
const expect1 = (id: string, r: { drafts: unknown[]; splitMerged: number; crossPageMerged: number }, needTrim?: boolean, trimmed?: number) => {
  const crops = r.drafts.length;
  const ok = crops === 1 && (!needTrim || (trimmed ?? 0) >= 1);
  results.push({ id, pass: ok, detail: `crops=${crops} (expect 1) split=${r.splitMerged} xpage=${r.crossPageMerged}${needTrim ? ` trimmed=${trimmed}` : ''}` });
};

const main = async (): Promise<void> => {
  whitePng = await sharp({ create: { width: PW, height: PH, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();

  // CASE 1 — Q left, options right column → 1 crop
  expect1('CASE 1 Q|options-right', await runCase([
    P(1, [D(0, 1, 1, '1. What is the value', 20, 100, 560, 260), D(1, 1, null, 'A) alpha B) beta C) gamma D) delta', 600, 100, 1150, 260)],
      [...stem(1, 25, 110), ...opts(610, 110)]),
  ]));

  // CASE 2 — options left, Q right → 1 crop
  expect1('CASE 2 options-left|Q', await runCase([
    P(1, [D(0, 1, null, 'A) alpha B) beta C) gamma D) delta', 20, 100, 560, 260), D(1, 1, 1, '1. What is the value', 600, 100, 1150, 260)],
      [...opts(30, 110), ...stem(1, 605, 110)]),
  ]));

  // CASE 3 — Q page N, options page N+1 → 1 crop
  expect1('CASE 3 Q-pN|options-pN+1', await runCase([
    P(1, [D(0, 1, 1, '1. What is the value', 20, 1500, 1150, 1620)], stem(1, 25, 1505)),
    P(2, [D(1, 2, null, 'A) alpha B) beta C) gamma D) delta', 20, 60, 1150, 200)], opts(30, 70)),
  ]));

  // CASE 4 — Q continues N+1, options N+1 → 1 crop
  expect1('CASE 4 Q-cont-pN+1+options', await runCase([
    P(1, [D(0, 1, 1, '1. What is the value', 20, 1500, 1150, 1620)], stem(1, 25, 1505)),
    P(2, [D(1, 2, null, 'of the given quantity A) alpha B) beta C) gamma D) delta', 20, 60, 1150, 260)], [...stemCont(30, 70), ...opts(30, 130)]),
  ]));

  // CASE 5 — Q continues N+1, options N+2 → 1 crop (3-page span)
  expect1('CASE 5 Q-cont-pN+1-options-pN+2', await runCase([
    P(1, [D(0, 1, 1, '1. What is the value', 20, 1500, 1150, 1620)], stem(1, 25, 1505)),
    P(2, [D(1, 2, null, 'of the given quantity', 20, 60, 1150, 180)], stemCont(30, 70)),
    P(3, [D(2, 3, null, 'A) alpha B) beta C) gamma D) delta', 20, 60, 1150, 200)], opts(30, 70)),
  ]));

  // CASE 6 — Q continues N+1, N+2, options N+2 → 1 crop (4-region span)
  expect1('CASE 6 Q-cont-x2-options', await runCase([
    P(1, [D(0, 1, 1, '1. What is the value', 20, 1500, 1150, 1620)], stem(1, 25, 1505)),
    P(2, [D(1, 2, null, 'of the given quantity', 20, 60, 1150, 180)], stemCont(30, 70)),
    P(3, [D(2, 3, null, 'of the given quantity', 20, 60, 1150, 180), D(3, 3, null, 'A) alpha B) beta C) gamma D) delta', 20, 200, 1150, 340)], [...stemCont(30, 70), ...opts(30, 210)]),
  ]));

  // CASE 7 — Q left col, Q right col, options below → 1 crop
  expect1('CASE 7 Q-2col+options-below', await runCase([
    P(1, [D(0, 1, 1, '1. What is the value', 20, 100, 560, 240), D(1, 1, null, 'of the given quantity', 600, 100, 1150, 240), D(2, 1, null, 'A) alpha B) beta C) gamma D) delta', 20, 300, 1150, 440)],
      [...stem(1, 25, 110), ...stemCont(605, 110), ...opts(30, 310)]),
  ]));

  // CASE 8 — Q top half, Q bottom half, options below → 1 crop
  expect1('CASE 8 Q-top+Q-bottom+options', await runCase([
    P(1, [D(0, 1, 1, '1. What is the value', 20, 100, 1150, 240), D(1, 1, null, 'of the given quantity', 20, 260, 1150, 400), D(2, 1, null, 'A) alpha B) beta C) gamma D) delta', 20, 420, 1150, 560)],
      [...stem(1, 25, 110), ...stemCont(30, 270), ...opts(30, 430)]),
  ]));

  // CASE 9-12 — Q pN; diagram/table/image/paragraph pN+1; options pN+1 → 1 crop
  const interposed = async (id: string, midText: string, midWords: ShadowWord[]) => expect1(id, await runCase([
    P(1, [D(0, 1, 1, '1. What is the value', 20, 1500, 1150, 1620)], stem(1, 25, 1505)),
    P(2, [D(1, 2, null, midText, 20, 60, 1150, 360), D(2, 2, null, 'A) alpha B) beta C) gamma D) delta', 20, 400, 1150, 540)], [...midWords, ...opts(30, 410)]),
  ]));
  await interposed('CASE 9 Q|diagram-pN+1|options', '[diagram]', [W('Fig', 400, 150, 500, 190), W('1', 510, 150, 540, 190)]);
  await interposed('CASE 10 Q|table-pN+1|options', 'row1 row2 col', [W('Row', 100, 100, 200, 130), W('Col', 300, 100, 400, 130), W('Val', 500, 100, 600, 130)]);
  await interposed('CASE 11 Q|image-pN+1|options', '[image]', [W('img', 400, 150, 520, 200)]);
  await interposed('CASE 12 Q|paragraph-pN+1|options', 'Read the following passage carefully and then answer', [W('Read', 30, 100, 120, 130), W('the', 126, 100, 180, 130), W('passage', 186, 100, 320, 130), W('carefully', 326, 100, 460, 130)]);

  // CASE 13-17, 30 — trailing solution/answer/explanation/hint below options → Q+Options ONLY (trim)
  const trailCase = async (id: string, leads: string[]) => {
    // options span y 160..280; place the trailing block well BELOW the option boundary (rule 4)
    let y = 360; const words = [...stem(1, 25, 110), ...opts(30, 160)];
    for (const lead of leads) { words.push(...trail(lead, 30, y)); y += 60; }
    const r = await runCase([P(1, [D(0, 1, 1, `1. What is the value A) alpha B) beta C) gamma D) delta ${leads.join(' ')}`, 20, 100, 1150, y + 40)], words)]);
    expect1(id, r, true, r.trimmedCrops);
  };
  await trailCase('CASE 13 +Solution', ['Sol.']);
  await trailCase('CASE 14 +Answer', ['Ans.']);
  await trailCase('CASE 15 +Explanation', ['Explanation:']);
  await trailCase('CASE 16 +Hint', ['Hint:']);
  await trailCase('CASE 17 +Answer+Solution', ['Ans.', 'Sol.']);
  await trailCase('CASE 30 +Sol+Ans+Explanation', ['Sol.', 'Ans.', 'Explanation:']);

  // CASE 18 — Q continues + options continue + answer → 1 crop, Q+O only
  {
    const r = await runCase([
      P(1, [D(0, 1, 1, '1. What is the value', 20, 1500, 1150, 1620)], stem(1, 25, 1505)),
      P(2, [D(1, 2, null, 'of the given quantity A) alpha B) beta C) gamma D) delta Ans. therefore', 20, 60, 1150, 360)], [...stemCont(30, 70), ...opts(30, 130), ...trail('Ans.', 30, 270)]),
    ]);
    expect1('CASE 18 cont+options+answer', r, true, r.trimmedCrops);
  }

  // CASE 19 — Q, handwritten number, options → 1 crop
  expect1('CASE 19 handwritten#+options', await runCase([
    P(1, [D(0, 1, null, '1. What is the value A) alpha B) beta C) gamma D) delta', 20, 100, 1150, 320)], [...stem(1, 25, 110), ...opts(30, 200)]),
  ]));

  // CASE 20 — Q, handwritten #, continues N+1, options N+1 → 1 crop
  expect1('CASE 20 handwritten+cont+options', await runCase([
    P(1, [D(0, 1, null, '1. What is the value', 20, 1500, 1150, 1620)], stem(1, 25, 1505)),
    P(2, [D(1, 2, null, 'of the given quantity A) alpha B) beta C) gamma D) delta', 20, 60, 1150, 260)], [...stemCont(30, 70), ...opts(30, 130)]),
  ]));

  // CASE 21-23 — Q, diagram/table/image mid, continues, options (same page) → 1 crop
  const midSame = async (id: string, midWords: ShadowWord[]) => expect1(id, await runCase([
    P(1, [D(0, 1, 1, '1. What is the value', 20, 100, 1150, 220), D(1, 1, null, 'mid', 20, 240, 1150, 380), D(2, 1, null, 'of the given quantity A) alpha B) beta C) gamma D) delta', 20, 400, 1150, 620)],
      [...stem(1, 25, 110), ...midWords, ...stemCont(30, 410), ...opts(30, 470)]),
  ]));
  await midSame('CASE 21 Q|diagram|cont|options', [W('Fig', 400, 280, 500, 320)]);
  await midSame('CASE 22 Q|table|cont|options', [W('Row', 100, 280, 200, 310), W('Col', 300, 280, 400, 310)]);
  await midSame('CASE 23 Q|image|cont|options', [W('img', 400, 280, 520, 330)]);

  // CASE 24-29 — Q, figure, options right-col / page N+1 → 1 crop
  const figOptRight = async (id: string, figWords: ShadowWord[]) => expect1(id, await runCase([
    P(1, [D(0, 1, 1, '1. What is the value', 20, 100, 560, 400), D(1, 1, null, 'A) alpha B) beta C) gamma D) delta', 600, 100, 1150, 260)],
      [...stem(1, 25, 110), ...figWords, ...opts(610, 110)]),
  ]));
  await figOptRight('CASE 24 Q|diagram|options-right', [W('Fig', 200, 260, 300, 300)]);
  const figOptNext = async (id: string, figWords: ShadowWord[]) => expect1(id, await runCase([
    P(1, [D(0, 1, 1, '1. What is the value', 20, 1300, 1150, 1620)], [...stem(1, 25, 1305), ...figWords]),
    P(2, [D(1, 2, null, 'A) alpha B) beta C) gamma D) delta', 20, 60, 1150, 200)], opts(30, 70)),
  ]));
  await figOptNext('CASE 25 Q|diagram|options-pN+1', [W('Fig', 400, 1450, 500, 1500)]);
  await figOptRight('CASE 26 Q|table|options-right', [W('Row', 100, 260, 200, 300)]);
  await figOptNext('CASE 27 Q|table|options-pN+1', [W('Row', 400, 1450, 520, 1500)]);
  await figOptRight('CASE 28 Q|image|options-right', [W('img', 200, 260, 320, 320)]);
  await figOptNext('CASE 29 Q|image|options-pN+1', [W('img', 400, 1450, 520, 1500)]);

  // CASE 31-35 — real PDFs, must NOT false-merge / stay separate
  await realCase('CASE 31 multi-column (separate)', 'C:/Users/hp/Downloads/AD 2601 Q.pdf', 149);
  await realCase('CASE 32 match-the-following', 'C:/Users/hp/Downloads/Biology_Cell.pdf', 92);
  await realCase('CASE 33 matrix/assertion (Biology_Cell)', 'C:/Users/hp/Downloads/Biology_Cell.pdf', 92);
  await realCase('CASE 34 diagram-heavy', 'C:/Users/hp/Downloads/Biology.pdf', 85);
  await realCase('CASE 35 assertion/reason (Biology_Cell)', 'C:/Users/hp/Downloads/Biology_Cell.pdf', 92);

  console.log('\n==== MASTER SUITE RESULT ====');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} — ${r.id}: ${r.detail}`);
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n${pass}/${results.length} PASS`);
  console.log('FAILS: ' + (results.filter((r) => !r.pass).map((r) => r.id).join(', ') || 'none'));
};

const collectWordBoxes = (d: any): OcrWordBox[] => {
  const out: OcrWordBox[] = [];
  for (const b of d?.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) for (const wd of l.words ?? []) {
    const t = (wd.text ?? '').trim(); if (!t || !wd.bbox) continue;
    const { x0, y0, x1, y1 } = wd.bbox; if ([x0, y0, x1, y1].some((v) => typeof v !== 'number')) continue;
    out.push({ text: t, x0, y0, x1, y1 });
  }
  return out;
};
const realCase = async (id: string, file: string, expected: number): Promise<void> => {
  try {
    const esm = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
    const { pdf } = await esm('pdf-to-img');
    const doc = await pdf(fs.readFileSync(file), { scale: 2 });
    const pgs: Buffer[] = []; for await (const p of doc) pgs.push(p as Buffer);
    const flat = await buildFlatField(pgs); const mask = buildWatermarkMask(flat);
    const worker = await createWorker('eng'); const base: OcrEngineDraft[] = []; const store = new Map<string, Buffer>();
    const wordsByPage: ShadowWord[][] = [];
    for (let i = 0; i < pgs.length; i += 1) {
      const clean = await cleanPageImage(pgs[i], flat);
      const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
      const wb = collectWordBoxes(data);
      const { drafts: vd } = await segmentVisualDrafts(clean, wb, i + 1, { putObject: async (k: string, b: Buffer) => { store.set(k, b); }, figureKeyPrefix: 'tenants/t/ocr-figures/job', positionOffset: base.length, displayFlat: flat, displayMask: mask, displaySource: pgs[i] } as any);
      base.push(...(vd as OcrEngineDraft[]));
      wordsByPage[i] = wb.map((x) => ({ text: x.text, x0: x.x0, y0: x.y0, x1: x.x1, y1: x.y1 }));
    }
    await worker.terminate();
    const drafts = base as unknown as DeliverableDraft[];
    const r = await delivery.deliver(drafts, { wordsByPage, pageImages: pgs }, io(store));
    const ok = r.drafts.length === expected && r.splitMerged === 0 && r.crossPageMerged === 0;
    results.push({ id, pass: ok, detail: `crops=${r.drafts.length} (expect ${expected}) falseSplit=${r.splitMerged} falseXpage=${r.crossPageMerged}` });
  } catch (e) {
    results.push({ id, pass: false, detail: `ERROR ${e instanceof Error ? e.message : String(e)}` });
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
