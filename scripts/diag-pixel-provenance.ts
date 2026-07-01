/* eslint-disable no-console */
/**
 * READ-ONLY pixel-provenance harness (no engine/detector/delivery/architecture changes).
 *
 * Validates CROP PIXEL correctness across the real production stages, per logical question:
 *
 *   S0 raw extract ─► S1 after background cleanup ─► [engine whiten+trim] ─► engine crop
 *                                                                              │
 *                                                       delivery re-crop ─► FINAL delivered crop
 *
 * Ground truth = the page OCR word boxes (the engine's own detection). Authoritative artifacts =
 * the REAL stored crops captured from putObject (engine crop) and the delivery re-crop. We OCR the
 * delivered crop to directly test "Question + Options together, nothing clipped", and pixel-compare
 * S0 vs S1 INSIDE the OCR word boxes to test "background cleanup touching content".
 *
 * Measures (PASS/FAIL each): (1) content-pixel loss, (2) option-band darkness before/after,
 * (3) header-trim clipping, (4) footer-trim clipping, (5) background touching content,
 * (6) missing-option root, (7) partial-crop root, (8) re-crop source inconsistency.
 *
 *   npx ts-node scripts/diag-pixel-provenance.ts "<pdf>" [sampleCount]
 */
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
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

const DARK = 160;                 // ink threshold (greyscale < DARK = dark ink)
const OPT_RE = /^\(?([A-Da-d1-4])[)\].:]/;  // option-marker grammar at a word/line start

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

const grey = async (buf: Buffer) => {
  const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height };
};
// dark-pixel count inside a localized box on a greyscale raster
const darkInBox = (data: Buffer, W: number, H: number, bx: { x0: number; y0: number; x1: number; y1: number }) => {
  let dark = 0, total = 0;
  const xA = Math.max(0, Math.floor(bx.x0)), xB = Math.min(W - 1, Math.ceil(bx.x1));
  const yA = Math.max(0, Math.floor(bx.y0)), yB = Math.min(H - 1, Math.ceil(bx.y1));
  for (let y = yA; y <= yB; y += 1) { const base = y * W; for (let x = xA; x <= xB; x += 1) { total += 1; if (data[base + x] < DARK) dark += 1; } }
  return { dark, total };
};
// option labels present in a crop's OCR text (distinct, lettered OR numbered set — whichever larger)
const optionLabelsInText = (text: string): Set<string> => {
  const letters = new Set<string>(), digits = new Set<string>();
  for (const raw of text.split(/\n+/)) {
    const m = OPT_RE.exec(raw.trim());
    if (!m) continue;
    const c = m[1].toLowerCase();
    if (/[a-d]/.test(c)) letters.add(c); else digits.add(c);
  }
  return letters.size >= digits.size ? letters : digits;
};

const run = async (file: string, sampleCount: number): Promise<void> => {
  if (!fs.existsSync(file)) { console.error(`PDF not found: ${file}`); process.exit(2); }
  const tag = path.basename(file).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 24);
  const outDir = `/tmp/recdiff/pixel_${tag}`;
  fs.mkdirSync(outDir, { recursive: true });
  const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(fs.readFileSync(file), { scale: 2 });
  const pages: Buffer[] = []; for await (const p of doc) pages.push(p as Buffer);
  const flat = await buildFlatField(pages); const mask = buildWatermarkMask(flat);
  const store = new Map<string, Buffer>();
  const putObject = async (key: string, body: Buffer) => { store.set(key, body); };
  const worker = await createWorker('eng');

  // ENGINE pass — capture per-page display image + word boxes + engine crops (in store).
  const wordsByPage: ShadowWord[][] = [];
  const pageWordsRaw: OcrWordBox[][] = [];
  const displayPages: Buffer[] = [];
  const base: OcrEngineDraft[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    const clean = await cleanPageImage(pages[i], flat);
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    const wb = collectWordBoxes(data);
    const displayPage = await cleanPageForDisplay(pages[i], flat, mask, wb);
    displayPages[i] = displayPage;
    pageWordsRaw[i] = wb;
    const { drafts: vd } = await segmentVisualDrafts(clean, wb, i + 1, { putObject, figureKeyPrefix: 'tenants/t/ocr-figures/job', positionOffset: base.length, displayFlat: flat, displayMask: mask, displaySource: displayPage } as any);
    base.push(...(vd as OcrEngineDraft[]));
    wordsByPage[i] = wb.map((x) => ({ text: x.text, x0: x.x0, y0: x.y0, x1: x.x1, y1: x.y1 }));
  }

  // RECONCILIATION provenance + DELIVERY (capture re-crops into the same store).
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
  const provByIdx = new Map<number, any>((report.appliedProvenance ?? []).map((pr: any) => [pr.draftIndex, pr]));
  const delivery = new OcrAnalysisDeliveryService(analyzer);
  const result = await delivery.deliver(base as unknown as DeliverableDraft[], { wordsByPage, pageImages: pages }, {
    getObject: async (k) => store.get(k) ?? Buffer.alloc(0), putObject, figureKeyPrefix: 'tenants/t/ocr-figures/job/merged',
  });
  const final = result.drafts as unknown as OcrEngineDraft[];
  // map engine-draft index → delivered draft (by surviving order). Delivered preserves emitted order.
  const emitted: any[] = (report.lifecycle ?? []).filter((l: any) => l.emittedCrop);
  const finalByIdx = new Map<number, OcrEngineDraft>();
  emitted.forEach((l, k) => { if (final[k]) finalByIdx.set(l.draftIndex, final[k]); });

  // SAMPLE: prefer trimmed questions (the suspect path); add kept controls. Evenly spread.
  const trimmedIdx = base.map((_, i) => i).filter((i) => typeof provByIdx.get(i)?.trimmedToY === 'number' && finalByIdx.has(i));
  const keptIdx = base.map((_, i) => i).filter((i) => finalByIdx.has(i) && typeof provByIdx.get(i)?.trimmedToY !== 'number' && !((provByIdx.get(i)?.mergedRegions?.length ?? 0) > 1));
  const spread = (arr: number[], n: number) => arr.length <= n ? arr : Array.from({ length: n }, (_, k) => arr[Math.floor(k * arr.length / n)]);
  const sample = [...spread(trimmedIdx, Math.max(6, sampleCount - 4)), ...spread(keptIdx, 4)].filter((v, i, a) => a.indexOf(v) === i);

  console.log(`\n================= PIXEL PROVENANCE — ${path.basename(file)} (${pages.length}pp) =================`);
  console.log(`engineDrafts=${base.length} delivered=${final.length} trimmedCrops=${result.trimmedCrops} | sampling ${sample.length} questions (trimmed-biased) | crops dumped to ${outDir}`);
  console.log(`stage legend: rawBoxInk=S0 ink in option/stem word-boxes · cleanBoxInk=S1 (after bg cleanup) · engOpts=options OCR'd in engine crop · finOpts=options OCR'd in delivered crop · expOpts=options the page-OCR detected`);

  const bgLuma = async (buf: Buffer): Promise<number> => { // median-ish background brightness (mean of bright pixels)
    const { data } = await grey(buf); let s = 0, n = 0; for (let i = 0; i < data.length; i += 1) if (data[i] >= 200) { s += data[i]; n += 1; } return n ? Math.round(s / n) : 255;
  };

  const fails: string[] = [];
  let dumpN = 0;
  const trimmedBg: number[] = []; const keptBg: number[] = [];
  console.log(`\nQ# | page | src | H raw→fin | bgInkLoss% | optBand loss% | expOpts | engOpts | finOpts | verdict`);
  for (const i of sample) {
    const d = base[i];
    const fin = finalByIdx.get(i)!;
    const reg = toBBox(d.sourceCoordinates); if (!reg) continue;
    const page = (d.sourcePageNumber ?? 1) - 1;
    const W = reg.x1 - reg.x0, H = reg.y1 - reg.y0;
    if (W < 2 || H < 2) continue;
    // region words (ground truth) + option/stem boxes localized to region origin
    const rw = pageWordsRaw[page].filter((w) => w.x0 >= reg.x0 - 2 && w.x1 <= reg.x1 + 2 && w.y0 >= reg.y0 - 2 && w.y1 <= reg.y1 + 2);
    const optBoxes = rw.filter((w) => OPT_RE.test(w.text)).map((w) => ({ x0: w.x0 - reg.x0, y0: w.y0 - reg.y0, x1: w.x1 - reg.x0, y1: w.y1 - reg.y0 }));
    const allBoxes = rw.map((w) => ({ x0: w.x0 - reg.x0, y0: w.y0 - reg.y0, x1: w.x1 - reg.x0, y1: w.y1 - reg.y0 }));
    const expLabels = new Set(rw.filter((w) => OPT_RE.test(w.text)).map((w) => OPT_RE.exec(w.text)![1].toLowerCase()));

    // S0 raw extract & S1 background-cleaned extract (SAME origin → per-box compare valid)
    const ex = { left: Math.max(0, reg.x0), top: Math.max(0, reg.y0), width: W, height: H };
    const s0 = await sharp(pages[page]).extract(ex).png().toBuffer();
    const s1 = await sharp(displayPages[page]).extract(ex).png().toBuffer();
    const g0 = await grey(s0); const g1 = await grey(s1);
    // background-touching-content: dark ink inside ALL word boxes that vanished S0→S1
    let dark0 = 0, lost = 0, optDark0 = 0, optLost = 0;
    for (const b of allBoxes) { const a = darkInBox(g0.data, g0.W, g0.H, b); dark0 += a.dark; }
    for (const b of allBoxes) {
      const xA = Math.max(0, Math.floor(b.x0)), xB = Math.min(g0.W - 1, Math.ceil(b.x1)), yA = Math.max(0, Math.floor(b.y0)), yB = Math.min(g0.H - 1, Math.ceil(b.y1));
      for (let y = yA; y <= yB; y += 1) for (let x = xA; x <= xB; x += 1) { const p = y * g0.W + x; if (g0.data[p] < DARK && g1.data[p] >= DARK) lost += 1; }
    }
    for (const b of optBoxes) { const a = darkInBox(g0.data, g0.W, g0.H, b); optDark0 += a.dark; }
    for (const b of optBoxes) {
      const xA = Math.max(0, Math.floor(b.x0)), xB = Math.min(g0.W - 1, Math.ceil(b.x1)), yA = Math.max(0, Math.floor(b.y0)), yB = Math.min(g0.H - 1, Math.ceil(b.y1));
      for (let y = yA; y <= yB; y += 1) for (let x = xA; x <= xB; x += 1) { const p = y * g0.W + x; if (g0.data[p] < DARK && g1.data[p] >= DARK) optLost += 1; }
    }
    const bgInkLossPct = dark0 ? Math.round((lost / dark0) * 1000) / 10 : 0;
    const optBandLossPct = optDark0 ? Math.round((optLost / optDark0) * 1000) / 10 : 0;

    // authoritative crops
    const engCrop = d.questionSnapshotKey ? store.get(d.questionSnapshotKey) : undefined;
    const finCrop = fin.questionSnapshotKey ? store.get(fin.questionSnapshotKey) : undefined;
    const finFromRaw = (fin.questionSnapshotKey ?? '').includes('/merged/'); // delivery re-crops live under .../merged/
    const engM = engCrop ? await sharp(engCrop).metadata() : { height: H };
    const finM = finCrop ? await sharp(finCrop).metadata() : { height: H };
    // OCR option labels in engine crop and delivered crop
    const engT = engCrop ? (await worker.recognize(engCrop)).data.text : '';
    const finT = finCrop ? (await worker.recognize(finCrop)).data.text : '';
    const engOpts = optionLabelsInText(engT); const finOpts = optionLabelsInText(finT);

    if (finFromRaw) trimmedBg.push(await bgLuma(finCrop!)); else if (finCrop) keptBg.push(await bgLuma(finCrop));

    // VERDICTS
    const v: string[] = [];
    if (bgInkLossPct > 5) v.push(`FAIL#5 bg-eats-content(${bgInkLossPct}%)`);
    if (optBandLossPct > 5) v.push(`FAIL#2/6 option-ink-erased(${optBandLossPct}%)`);
    if (finOpts.size < engOpts.size) v.push(`FAIL#6/4 option-lost-in-delivery(${engOpts.size}→${finOpts.size})`);
    if (engOpts.size < expLabels.size && expLabels.size >= 2) v.push(`WARN engine-crop-fewer-opts(${expLabels.size}→${engOpts.size})`);
    const hRaw = H, hFin = finM.height ?? H;
    if (hFin < 0.5 * hRaw && (finOpts.size < Math.max(2, expLabels.size))) v.push(`FAIL#3/7 partial-crop(H ${hRaw}→${hFin}, opts ${finOpts.size})`);
    const verdict = v.length ? v.join(' ') : 'PASS';
    if (v.some((s) => s.startsWith('FAIL'))) {
      fails.push(`Q${d.questionNumber ?? '?'}(p${page + 1}): ${verdict}`);
      if (dumpN < 6 && engCrop && finCrop) { fs.writeFileSync(`${outDir}/Q${d.questionNumber}_S0raw.png`, s0); fs.writeFileSync(`${outDir}/Q${d.questionNumber}_S1bgclean.png`, s1); fs.writeFileSync(`${outDir}/Q${d.questionNumber}_engine.png`, engCrop); fs.writeFileSync(`${outDir}/Q${d.questionNumber}_final.png`, finCrop); dumpN += 1; }
    }
    console.log(`Q${d.questionNumber ?? '?'} | ${page + 1} | ${finFromRaw ? 'RAW' : 'disp'} | ${hRaw}→${hFin} | ${bgInkLossPct} | ${optBandLossPct} | ${expLabels.size} | ${engOpts.size} | ${finOpts.size} | ${verdict}`);
  }
  await worker.terminate();

  const med = (a: number[]) => a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : 0;
  console.log(`\n[#8 re-crop source consistency] delivered-crop background brightness: trimmed(RAW-source) median=${med(trimmedBg)} (${trimmedBg.length}) vs kept(display-source) median=${med(keptBg)} (${keptBg.length}) → Δ=${Math.abs(med(trimmedBg) - med(keptBg))}`);
  console.log(`\nSUMMARY ${path.basename(file)}: ${fails.length} FAIL of ${sample.length} sampled.`);
  if (fails.length) console.log(fails.map((f) => '  ❌ ' + f).join('\n')); else console.log('  ✅ all sampled questions pixel-PASS');
  console.log(`(stage crops for first ${dumpN} fails dumped under ${outDir})`);
};
const args = process.argv.slice(2);
run(args[0] ?? 'fixtures/sample-paper.pdf', Number(args[1]) || 14).catch((e) => { console.error(e); process.exit(1); });
