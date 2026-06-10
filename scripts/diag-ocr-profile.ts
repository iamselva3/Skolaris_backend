/* eslint-disable no-console */
/**
 * Read-only OCR profiler. Mirrors the EXACT engine stages (render → flat field →
 * per-page clean → tesseract → segmentVisualDrafts → quality report) with a timer
 * around each, so we can see where wall-clock goes. No DB / storage / Nest.
 *
 *   npx ts-node scripts/diag-ocr-profile.ts "C:\path\to\paper.pdf"
 */
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import { buildFlatField, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import {
  segmentVisualDrafts,
  buildQualityReport,
  type PageMarkerTrace,
} from '../src/shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';
import type { OcrEngineDraft } from '../src/shared/ocr-engine/ocr-engine';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
const ms = (n: number): string => `${(n / 1000).toFixed(2)}s`;
const memMB = (): number => Math.round(process.memoryUsage().rss / 1024 / 1024);

const collectWordBoxes = (data: any): OcrWordBox[] => {
  const out: OcrWordBox[] = [];
  for (const b of data?.blocks ?? [])
    for (const p of b.paragraphs ?? [])
      for (const l of p.lines ?? [])
        for (const w of l.words ?? []) {
          const t = (w.text ?? '').trim();
          if (!t || !w.bbox) continue;
          const { x0, y0, x1, y1 } = w.bbox;
          if ([x0, y0, x1, y1].some((v) => typeof v !== 'number')) continue;
          out.push({ text: t, x0, y0, x1, y1 });
        }
  return out;
};

const main = async (): Promise<void> => {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) throw new Error(`PDF not found: ${file}`);
  const bytes = fs.readFileSync(file);
  const T0 = Date.now();

  // ── Stage 1: render all pages (pdf-to-img scale 2) ──
  const r0 = Date.now();
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(bytes, { scale: 2 });
  const pageBuffers: Buffer[] = [];
  for await (const p of doc) pageBuffers.push(p as Buffer);
  const tRender = Date.now() - r0;
  const meta0 = await sharp(pageBuffers[0]).metadata();
  console.log(
    `[profile] file=${file.split(/[\\/]/).pop()} pages=${pageBuffers.length} res=${meta0.width}x${meta0.height} bytes=${bytes.length}`,
  );

  // ── Stage 2: watermark flat field ──
  const f0 = Date.now();
  const flat = await buildFlatField(pageBuffers);
  const tFlat = Date.now() - f0;

  const worker = await createWorker('eng');
  const drafts: OcrEngineDraft[] = [];
  const traces: PageMarkerTrace[] = [];
  const putObject = async (): Promise<void> => undefined; // no-op storage

  let tClean = 0;
  let tOcr = 0;
  let tSeg = 0;
  let pageNum = 0;
  for (const raw of pageBuffers) {
    pageNum += 1;
    const c0 = Date.now();
    const clean = await cleanPageImage(raw, flat);
    tClean += Date.now() - c0;

    const o0 = Date.now();
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    const tPageOcr = Date.now() - o0;
    tOcr += tPageOcr;
    const wordBoxes = collectWordBoxes(data);

    const s0 = Date.now();
    const { drafts: vd, trace } = await segmentVisualDrafts(clean, wordBoxes, pageNum, {
      putObject,
      figureKeyPrefix: 'diag',
      positionOffset: drafts.length,
    });
    const tPageSeg = Date.now() - s0;
    tSeg += tPageSeg;
    drafts.push(...vd);
    traces.push(trace);
    console.log(
      `[profile] page ${pageNum}: ocr=${ms(tPageOcr)} seg=${ms(tPageSeg)} drafts=${vd.length} words=${wordBoxes.length} mem=${memMB()}MB`,
    );
  }
  await worker.terminate();

  // ── Stage 5: draft generation / quality report ──
  const q0 = Date.now();
  const report = buildQualityReport(drafts, Number(process.env.OCR_EXPECTED_QUESTIONS) || null, traces);
  const tReport = Date.now() - q0;

  const total = Date.now() - T0;
  const pages = pageBuffers.length;
  const pct = (n: number): string => `${((n / total) * 100).toFixed(1)}%`;
  console.log(`\n========== STAGE PROFILE (total ${ms(total)}, ${pages} pages) ==========`);
  console.log(`1. PDF render (pdf-to-img scale2) : ${ms(tRender)}  ${pct(tRender)}   (${ms(tRender / pages)}/pg)`);
  console.log(`2. Watermark flat field            : ${ms(tFlat)}  ${pct(tFlat)}`);
  console.log(`3. Page clean (sharp divide)       : ${ms(tClean)}  ${pct(tClean)}   (${ms(tClean / pages)}/pg)`);
  console.log(`4. OCR extraction (tesseract)      : ${ms(tOcr)}  ${pct(tOcr)}   (${ms(tOcr / pages)}/pg)`);
  console.log(`5. Segmentation + crops            : ${ms(tSeg)}  ${pct(tSeg)}   (${ms(tSeg / pages)}/pg)`);
  console.log(`6. Quality report (draft-gen)      : ${ms(tReport)}  ${pct(tReport)}`);
  console.log(`detected=${report.detected} expected=${report.expected ?? '?'} coverage=${report.coveragePct}%`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
