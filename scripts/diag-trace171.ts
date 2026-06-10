/* eslint-disable no-console */
/**
 * Full per-stage trace for the 169 / 270 / 171 merge on a given PDF page.
 * Runs the REAL exported pipeline functions in the same order segmentVisualDrafts
 * uses them, and prints marker creation / sequence keep / region build / split /
 * recovery / final draft numbers, highlighting 169, 270, 171.
 *
 *   npx ts-node scripts/diag-trace171.ts "<pdf>" <pageIdx>
 */
import sharp from 'sharp';
import * as fs from 'fs';
import { createWorker } from 'tesseract.js';
import { filterRepeatedWatermarks, type OcrWordBox } from '../src/shared/ocr-engine/column-reorder';
import {
  medianHeight,
  detectQuestionPunct,
  recoverTruncatedNumbers,
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

// local copy of the module-private isQuestionNumberToken (for the restore step)
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

const FOCUS = [169, 270, 171];

const main = async (): Promise<void> => {
  const file = process.argv[2];
  const pageIdx = Number(process.argv[3] ?? 1);
  const bytes = fs.readFileSync(file);
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(bytes, { scale: 2 });
  const pages: Buffer[] = [];
  for await (const p of doc) pages.push(p as Buffer);
  const pageImage = pages[pageIdx - 1];
  const meta = await sharp(pageImage).metadata();
  const pageWidth = meta.width!;
  const pageHeight = meta.height!;

  const worker = await createWorker('eng');
  const { data } = await worker.recognize(pageImage, {}, { blocks: true } as any);
  const rawWords = collectWordBoxes(data);
  await worker.terminate();

  // ---- replicate segmentVisualDrafts preprocessing ----
  const filtered = filterRepeatedWatermarks(rawWords);
  const keptSet = new Set(filtered);
  const restored = rawWords.filter((w) => !keptSet.has(w) && isQNum(w.text));
  const words = restored.length > 0 ? [...filtered, ...restored] : filtered;
  const medianH = medianHeight(words);
  const qP = detectQuestionPunct(words, medianH);
  const padTop = Math.round(medianH * 0.6);
  const padBottom = Math.round(medianH * 0.4);
  recoverTruncatedNumbers(words, pageWidth, medianH, qP);

  console.log(`\n==== PAGE ${pageIdx} (${pageWidth}x${pageHeight}) medianH=${medianH} qPunct='${qP}' ====`);

  // RAW OCR tokens for the focus numbers
  console.log(`\n-- RAW OCR tokens (focus) --`);
  for (const w of words) {
    const m = /^(\d{1,3})/.exec(stripLead(w.text));
    if (m && FOCUS.includes(+m[1])) console.log(`  ${+m[1]}: "${w.text}" @(${w.x0},${w.y0})`);
  }

  // Marker detection
  const markers = findQuestionMarkers(words, medianH, qP);
  const markerNums = markers.map((m) => m.num);
  console.log(`\n-- findQuestionMarkers → markers (num@x,y, y-sorted) --`);
  console.log('  ' + markers.map((m) => `${m.num}@(${m.x0},${m.y0})`).join('  '));
  for (const n of FOCUS) console.log(`  marker ${n} created? ${markerNums.includes(n) ? 'YES' : 'NO'}`);

  // Columns + sequence validation
  const cols = detectColumns(markers, pageWidth);
  console.log(`\n-- detectColumns → ${cols.length} column(s) --`);
  cols.forEach((c, i) =>
    console.log(`  col${i} x[${Math.round(c.left)}-${Math.round(c.right)}]: [${c.markers.map((m) => m.num).join(',')}]`),
  );
  console.log(`\nSequence Validation Input:`);
  cols.forEach((c, i) => console.log(`  col${i}: [${[...c.markers].sort((a, b) => a.y0 - b.y0).map((m) => m.num).join(', ')}]`));

  const validated = validateMarkerSequence(cols);
  console.log(`\nSequence Validation Output:`);
  validated.forEach((c, i) => console.log(`  col${i}: [${c.markers.map((m) => m.num).join(', ')}]`));
  const keptNums = validated.flatMap((c) => c.markers.map((m) => m.num));
  for (const n of FOCUS) {
    const created = markerNums.includes(n);
    const kept = keptNums.includes(n);
    console.log(`  marker ${n}: created=${created ? 'YES' : 'NO'} kept=${kept ? 'YES' : 'NO'}${created && !kept ? '  → REMOVED in sequence validation' : ''}`);
  }

  // Region build
  console.log(`\nRegion Build Input (validated column markers): [${keptNums.join(', ')}]`);
  const built = buildRegions(validated, pageWidth, pageHeight, medianH, padTop, padBottom);
  console.log(`Region Build Output (topNum @ y-range):`);
  built.forEach((r) => console.log(`  ${topNum(words, r, medianH, qP)} @ y[${r.y0}-${r.y1}] x[${r.x0}-${r.x1}]`));

  // Internal split
  const split = splitRegionsByInternalMarkers(built, words, medianH, qP, padTop);
  console.log(`\nsplitRegionsByInternalMarkers Output (topNum @ y-range):`);
  split.forEach((r) => console.log(`  ${topNum(words, r, medianH, qP)} @ y[${r.y0}-${r.y1}]`));

  // Gap recovery
  const recovered = recoverSequenceGaps(split, words, medianH, qP, padTop);
  console.log(`\nrecoverSequenceGaps Output (topNum @ y-range):`);
  recovered.forEach((r) => console.log(`  ${topNum(words, r, medianH, qP)} @ y[${r.y0}-${r.y1}]`));

  // Final draft numbers + which region holds 171's token
  const finalNums = recovered.map((r) => topNum(words, r, medianH, qP));
  console.log(`\nFinal Draft Numbers: [${finalNums.join(', ')}]`);
  const tok171 = words.find((w) => /^171/.test(stripLead(w.text)));
  if (tok171) {
    const host = recovered.find((r) => {
      const cx = (tok171.x0 + tok171.x1) / 2;
      const cy = (tok171.y0 + tok171.y1) / 2;
      return cx >= r.x0 && cx < r.x1 && cy >= r.y0 && cy < r.y1;
    });
    console.log(`171 token @(${tok171.x0},${tok171.y0}) lives inside the draft whose topNum = ${host ? topNum(words, host, medianH, qP) : 'NONE'} (y[${host?.y0}-${host?.y1}])`);
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
