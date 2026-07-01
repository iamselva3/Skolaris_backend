/* eslint-disable no-console */
/**
 * READ-ONLY: runs the real paper pass and, for every `split-orphan-associable` finding (the ones the
 * applier auto-merges), prints the orphan + candidate-stem text/coords/mode/markerFreePath and saves
 * the orphan crop, the candidate crop, and their union — so a human can confirm the merge is genuine
 * (NOT a false merge). Reuses existing detectors only; no engine change.
 *
 *   npx ts-node scripts/diag-splitmerge.ts "<pdf>"
 */
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { segmentVisualDrafts } from '../src/shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';
import type { OcrEngineDraft } from '../src/shared/ocr-engine/ocr-engine';
import { detectSplitOrphans } from '../src/modules/ocr-analysis/split-question';
import type { PaperDetectorContext, ShadowDraft, ShadowWord } from '../src/modules/ocr-analysis/contracts';

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
  const out = 'C:/Users/hp/Downloads/_splitmerge'; fs.mkdirSync(out, { recursive: true });
  const base = path.basename(file).replace(/\W+/g, '_');
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(fs.readFileSync(file), { scale: 2 });
  const pageBufs: Buffer[] = [];
  for await (const p of doc) pageBufs.push(p as Buffer);
  const flat = await buildFlatField(pageBufs);
  const mask = buildWatermarkMask(flat);
  const worker = await createWorker('eng');
  const allDrafts: ShadowDraft[] = [];
  const wordsByPage: ShadowWord[][] = [];
  const pageOf = new Map<number, Buffer>();
  let total = 0;
  for (let i = 0; i < pageBufs.length; i += 1) {
    const clean = await cleanPageImage(pageBufs[i], flat);
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    const wb = collectWordBoxes(data);
    const { drafts: vd } = await segmentVisualDrafts(clean, wb, i + 1, {
      putObject: async () => undefined, figureKeyPrefix: 'sm', positionOffset: total, displayFlat: flat, displayMask: mask, displaySource: pageBufs[i],
    } as any);
    (vd as OcrEngineDraft[]).forEach((d, k) => allDrafts.push({ index: total + k, page: i + 1, questionNumber: d.questionNumber ?? null, text: d.text ?? '', coords: d.sourceCoordinates }));
    wordsByPage.push(wb.map((w) => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 })));
    pageOf.set(i + 1, pageBufs[i]);
    total += vd.length;
  }
  await worker.terminate();

  const pctx: PaperDetectorContext = { drafts: allDrafts, pages: [], wordsByPage };
  const findings = detectSplitOrphans(pctx);
  const associable = findings.filter((f) => f.kind === 'split-orphan-associable');
  const byIdx = new Map(allDrafts.map((d) => [d.index, d]));
  console.log(`\n==== ${path.basename(file)} :: associable merges = ${associable.length} (unresolved=${findings.length - associable.length}) ====`);
  const crop = async (page: number, c: any, fn: string) => {
    const buf = pageOf.get(page)!; const meta = await sharp(buf).metadata();
    const W = meta.width ?? 0, H = meta.height ?? 0;
    await sharp(buf).extract({ left: Math.max(0, c.x0), top: Math.max(0, c.y0), width: Math.min(W - c.x0, c.x1 - c.x0), height: Math.min(H - c.y0, c.y1 - c.y0) }).png().toFile(path.join(out, fn));
  };
  for (const f of associable) {
    const ev = f.evidence as any;
    const orphan = byIdx.get(ev.orphanDraft); const stem = ev.candidateStem != null ? byIdx.get(ev.candidateStem) : null;
    console.log(`\n  MERGE mode=${ev.mode} markerFreePath=${ev.markerFreePath} page=${f.target.page}`);
    console.log(`   STEM   d${stem?.index} q#=${stem?.questionNumber} "${(stem?.text ?? '').replace(/\s+/g, ' ').slice(0, 90)}"`);
    console.log(`   ORPHAN d${orphan?.index} q#=${orphan?.questionNumber} "${(orphan?.text ?? '').replace(/\s+/g, ' ').slice(0, 90)}"`);
    if (stem?.coords) await crop(stem.page, stem.coords, `${base}-m${orphan?.index}-STEM.png`);
    if (orphan?.coords) await crop(orphan.page, orphan.coords, `${base}-m${orphan?.index}-ORPHAN.png`);
    if (stem?.coords && orphan?.coords) {
      const u = { x0: Math.min(stem.coords.x0, orphan.coords.x0), y0: Math.min(stem.coords.y0, orphan.coords.y0), x1: Math.max(stem.coords.x1, orphan.coords.x1), y1: Math.max(stem.coords.y1, orphan.coords.y1) };
      await crop(stem.page, u, `${base}-m${orphan?.index}-UNION.png`);
    }
  }
  console.log(`\ncrops → ${out}`);
};
main().catch((e) => { console.error(e); process.exit(1); });
