/* eslint-disable no-console */
/**
 * Production-accurate per-STAGE segmentation trace for ONE page: OCRs the CLEANED
 * page (cleanPageImage, exactly like production) then runs the segmenter's internal
 * stages in order, printing markers created / kept after sequence validation /
 * regions / split / recovered, highlighting FOCUS numbers. Reveals exactly where a
 * column merges and where a mislabel originates.
 *
 *   npx ts-node scripts/diag-trace-page.ts "<pdf>" <pageIdx> "<focus,csv>"
 */
import sharp from 'sharp';
import * as fs from 'fs';
import { createWorker } from 'tesseract.js';
import { buildFlatField, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { filterRepeatedWatermarks, type OcrWordBox } from '../src/shared/ocr-engine/column-reorder';
import {
  medianHeight,
  detectQuestionPunct,
  recoverTruncatedNumbers,
  recoverCenturyMisreads,
  findQuestionMarkers,
  detectColumns,
  validateMarkerSequence,
  buildRegions,
  splitRegionsByInternalMarkers,
  recoverSequenceGaps,
  type Region,
} from '../src/shared/ocr-engine/visual-segment';

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

const stripLead = (t: string): string => t.replace(/^["'`|.,;:_\-—\s]+/, '');
const isQNum = (t: string): boolean => {
  const s = stripLead(t);
  return (
    /^(\d{1,3})[.:](?!\d+(?![A-Za-z]))/.test(s) ||
    /^(\d{1,3})\)(?!\d)/.test(s) ||
    /^Q\.?\s?(\d{1,3})\b/i.test(s) ||
    /^(\d{2,3})(?=[A-Za-z])/.test(s)
  );
};
const wordsInRegion = (words: OcrWordBox[], r: Region): OcrWordBox[] =>
  words.filter((w) => {
    const cx = (w.x0 + w.x1) / 2;
    const cy = (w.y0 + w.y1) / 2;
    return cx >= r.x0 && cx < r.x1 && cy >= r.y0 && cy < r.y1;
  });
const topNum = (words: OcrWordBox[], r: Region, medianH: number, qP: ')' | '.'): number | null => {
  const m = findQuestionMarkers(wordsInRegion(words, r), medianH, qP)[0];
  return m && m.num !== undefined && !Number.isNaN(m.num) ? m.num : null;
};

const main = async (): Promise<void> => {
  const file = process.argv[2];
  const pageIdx = Number(process.argv[3] ?? 1);
  const FOCUS = (process.argv[4] ?? '').split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
  const bytes = fs.readFileSync(file);
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(bytes, { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  const flat = await buildFlatField(pages);
  const cleaned = await cleanPageImage(pages[pageIdx - 1], flat); // PRODUCTION input
  const meta = await sharp(cleaned).metadata();
  const pageWidth = meta.width!;
  const pageHeight = meta.height!;

  const worker = await createWorker('eng');
  const { data } = await worker.recognize(cleaned, {}, { blocks: true } as any);
  const rawWords = collectWordBoxes(data);
  await worker.terminate();

  // replicate segmentVisualDrafts preprocessing
  const filtered = filterRepeatedWatermarks(rawWords);
  const keptSet = new Set(filtered);
  const restored = rawWords.filter((w) => !keptSet.has(w) && isQNum(w.text));
  const words = restored.length > 0 ? [...filtered, ...restored] : filtered;
  const medianH = medianHeight(words);
  const qP = detectQuestionPunct(words, medianH);
  const padTop = Math.round(medianH * 0.6);
  const padBottom = Math.round(medianH * 0.4);
  // Optional token probe around a coordinate: argv[5]=x argv[6]=y (each pass).
  const px0 = Number(process.argv[5]);
  const py0 = Number(process.argv[6]);
  const near = (label: string) => {
    if (Number.isNaN(px0) || Number.isNaN(py0)) return;
    const hits = words.filter((w) => Math.abs(w.x0 - px0) <= 12 && Math.abs(w.y0 - py0) <= 12);
    console.log(`  [${label}] tokens@(${px0},${py0}): ${hits.map((h) => `"${h.text}"@(${h.x0},${h.y0})`).join(' ') || 'NONE'}`);
  };
  near('before recovery');
  recoverTruncatedNumbers(words, pageWidth, medianH, qP);
  near('after recoverTruncatedNumbers');
  recoverCenturyMisreads(words, pageWidth, medianH, qP);
  near('after recoverCenturyMisreads');

  console.log(`\n==== PAGE ${pageIdx} (${pageWidth}x${pageHeight}) medianH=${medianH} qP='${qP}' FOCUS=[${FOCUS}] ====`);

  const markers = findQuestionMarkers(words, medianH, qP);
  console.log(`\n-- findQuestionMarkers (num@x,y) --`);
  console.log('  ' + markers.map((m) => `${m.num}@(${m.x0},${m.y0})`).join('  '));

  const cols = detectColumns(markers, pageWidth);
  console.log(`\n-- detectColumns → ${cols.length} col(s) --`);
  cols.forEach((c, i) =>
    console.log(`  col${i} x[${Math.round(c.left)}-${Math.round(c.right)}]: [${[...c.markers].sort((a, b) => a.y0 - b.y0).map((m) => m.num).join(',')}]`),
  );

  const validated = validateMarkerSequence(cols);
  console.log(`\n-- validateMarkerSequence → kept per col --`);
  validated.forEach((c, i) => console.log(`  col${i}: [${c.markers.map((m) => m.num).join(',')}]`));
  const created = markers.map((m) => m.num);
  const kept = validated.flatMap((c) => c.markers.map((m) => m.num));
  for (const n of FOCUS)
    console.log(`  ${n}: created=${created.includes(n) ? 'Y' : 'N'} kept=${kept.includes(n) ? 'Y' : 'N'}${created.includes(n) && !kept.includes(n) ? '  ← EVICTED by sequence validation' : ''}`);

  const built = buildRegions(validated, pageWidth, pageHeight, medianH, padTop, padBottom);
  console.log(`\n-- buildRegions (topNum @ y) --`);
  built.forEach((r) => console.log(`  ${topNum(words, r, medianH, qP)} @ y[${r.y0}-${r.y1}] x[${r.x0}-${r.x1}]`));

  const split = splitRegionsByInternalMarkers(built, words, medianH, qP, padTop);
  console.log(`\n-- splitRegionsByInternalMarkers --`);
  split.forEach((r) => console.log(`  ${topNum(words, r, medianH, qP)} @ y[${r.y0}-${r.y1}]`));

  const recovered = recoverSequenceGaps(split, words, medianH, qP, padTop);
  console.log(`\n-- recoverSequenceGaps (FINAL draft topNums) --`);
  recovered.forEach((r) => console.log(`  ${topNum(words, r, medianH, qP)} @ y[${r.y0}-${r.y1}] x[${r.x0}-${r.x1}]`));
  console.log(`\nFINAL: [${recovered.map((r) => topNum(words, r, medianH, qP)).join(', ')}]`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
