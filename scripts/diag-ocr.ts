/* eslint-disable no-console */
/**
 * Standalone OCR segmentation diagnostic. Reproduces the EXACT in-process
 * pipeline (watermark flat-field → tesseract → segmentVisualDrafts →
 * buildQualityReport) on a single PDF, with NO DB / storage / Nest, so the
 * full per-question trace can be printed (the engine log caps it at 50 rows).
 *
 *   npx ts-node scripts/diag-ocr.ts "C:\path\to\paper.pdf"
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
  console.log(`[diag] file=${file} bytes=${bytes.length}`);

  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(bytes, { scale: 2 });
  const pageBuffers: Buffer[] = [];
  for await (const p of doc) pageBuffers.push(p as Buffer);
  const meta0 = await sharp(pageBuffers[0]).metadata();
  console.log(`[diag] pages=${pageBuffers.length} res=${meta0.width}x${meta0.height}`);

  const flat = await buildFlatField(pageBuffers);
  console.log(`[diag] flatField=${flat ? `${flat.width}x${flat.height}` : 'null (disabled/<3pp)'}`);

  const worker = await createWorker('eng');
  const drafts: OcrEngineDraft[] = [];
  const traces: PageMarkerTrace[] = [];
  const putObject = async (): Promise<void> => undefined; // no-op storage

  let pageNum = 0;
  for (const raw of pageBuffers) {
    pageNum += 1;
    const clean = await cleanPageImage(raw, flat);
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    const wordBoxes = collectWordBoxes(data);
    const { drafts: vd, trace } = await segmentVisualDrafts(clean, wordBoxes, pageNum, {
      putObject,
      figureKeyPrefix: 'diag',
      positionOffset: drafts.length,
    });
    drafts.push(...vd);
    traces.push(trace);
    console.log(
      `[diag] page ${pageNum}: words=${wordBoxes.length} cols=${trace.columnCount} drafts=${vd.length}\n` +
        `        ocrNums =[${[...new Set(trace.ocrNumbers.map((o) => o.num))].sort((a, b) => a - b).join(',')}]\n` +
        `        marker  =[${trace.markerNumbers.join(',')}]\n` +
        `        kept    =[${trace.keptNumbers.join(',')}]\n` +
        `        draftQ# =[${vd.map((d) => d.questionNumber ?? 'null').join(',')}]`,
    );
  }
  await worker.terminate();

  const expected = Number(process.env.OCR_EXPECTED_QUESTIONS) || null;
  const report = buildQualityReport(drafts, expected, traces);

  console.log(`\n========== SUMMARY ==========`);
  console.log(
    `detected=${report.detected} expected=${report.expected ?? '?'} coverage=${report.coveragePct}% ` +
      `missing=${report.missingNumbers.length} duplicates=${report.duplicateNumbers.length} ` +
      `multiQuestionCrops=${report.multiQuestionCrops.length} invalidCrops=${report.invalidCrops} ` +
      `numbersLost=${report.missingQuestionNumberPositions.length} needsReview=${report.needsManualReview}`,
  );
  console.log(`detected questionNumbers: [${[...new Set(drafts.map((d) => d.questionNumber).filter((n): n is number => n != null))].sort((a, b) => a - b).join(',')}]`);
  console.log(`multiQuestionCrops:`, JSON.stringify(report.multiQuestionCrops));

  console.log(`\n========== MISSING — REAL RANGE (>=85) ==========`);
  for (const m of report.missing.filter((x) => x.expected >= 85)) {
    console.log(
      `Question=${m.expected} OCR=${m.ocrDetected ? 'YES' : 'NO'} Marker=${m.markerDetected ? 'YES' : 'NO'} ` +
        `Boundary=NO Draft=NO stage=${m.stage} removedInSequence=${m.removedInSequence ? 'YES' : 'NO'} ` +
        `mergedIntoDraft=${m.mergedIntoDraft ?? '-'} prev=${m.previous ?? '?'} next=${m.next ?? '?'} ` +
        `page=${m.page ?? '?'} col=${m.column ?? '?'}`,
    );
  }

  const phantoms = report.missing.filter((x) => x.expected < 85);
  console.log(`\n========== PHANTOM MISSING (expected < 85) count=${phantoms.length} ==========`);
  for (const m of phantoms.slice(0, 4))
    console.log(`Question=${m.expected} OCR=${m.ocrDetected ? 'YES' : 'NO'} prev=${m.previous ?? '?'} next=${m.next ?? '?'} stage=${m.stage}`);
  console.log(`... (these 1..84 entries are the artifact: report counts from 1, doc starts at 89)`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
