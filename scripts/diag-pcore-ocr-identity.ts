/* eslint-disable no-console */
/**
 * OCR-IDENTITY proof for OCR_DISPLAY_WM_PERSISTENT_CORE. Runs the real OCR once per
 * page (the slow part), then runs segmentVisualDrafts TWICE on the SAME word boxes —
 * PC off vs PC on — WITH displayFlat + displayMask passed, so cleanCropForDisplay
 * (and therefore persistentCore) actually executes. It then diffs every draft field
 * except the random image key, and the quality report (detected / coverage / numbers).
 *
 * If persistentCore is display-only, the two runs are byte-identical on:
 *   draft count, questionNumber, sourceCoordinates {x0,y0,x1,y1}, optionCount,
 *   invalidCrop, confidence, position — and report detected / coverage / missing.
 *
 *   npx ts-node scripts/diag-pcore-ocr-identity.ts "<pdf>"
 */
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import { buildFlatField, buildWatermarkMask, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { segmentVisualDrafts, buildQualityReport, type PageMarkerTrace } from '../src/shared/ocr-engine/visual-segment';
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

// Every draft field that matters for detection (excludes the random image key).
const sig = (d: OcrEngineDraft): string =>
  JSON.stringify({
    position: d.position,
    questionNumber: d.questionNumber,
    detectedType: d.detectedType,
    questionClass: d.questionClass,
    confidence: d.confidence,
    optionCount: d.optionCount,
    invalidCrop: d.invalidCrop,
    needsImageReview: d.needsImageReview ?? false,
    sourceColumn: d.sourceColumn,
    sourceColumnCount: d.sourceColumnCount,
    sourcePageNumber: d.sourcePageNumber,
    coords: d.sourceCoordinates,
  });

const segmentAll = async (
  label: string,
  pcOn: boolean,
  pageBuffers: Buffer[],
  cleaned: Buffer[],
  wordBoxesByPage: OcrWordBox[][],
  flat: any,
  mask: any,
): Promise<{ drafts: OcrEngineDraft[]; traces: PageMarkerTrace[] }> => {
  if (pcOn) process.env.OCR_DISPLAY_WM_PERSISTENT_CORE = 'true';
  else delete process.env.OCR_DISPLAY_WM_PERSISTENT_CORE;
  process.env.OCR_DISPLAY_BG_TRAIL = 'true'; // baseline-as-enabled in both runs
  const putObject = async (): Promise<void> => undefined;
  const drafts: OcrEngineDraft[] = [];
  const traces: PageMarkerTrace[] = [];
  for (let i = 0; i < pageBuffers.length; i += 1) {
    const { drafts: vd, trace } = await segmentVisualDrafts(cleaned[i], wordBoxesByPage[i], i + 1, {
      putObject,
      figureKeyPrefix: 'diag',
      positionOffset: drafts.length,
      displayFlat: flat,
      displayMask: mask,
    } as any);
    drafts.push(...vd);
    traces.push(trace);
  }
  delete process.env.OCR_DISPLAY_WM_PERSISTENT_CORE;
  delete process.env.OCR_DISPLAY_BG_TRAIL;
  console.log(`[${label}] drafts=${drafts.length}`);
  return { drafts, traces };
};

const main = async (): Promise<void> => {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) throw new Error(`PDF not found: ${file}`);
  const bytes = fs.readFileSync(file);
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(bytes, { scale: 2 });
  const pageBuffers: Buffer[] = [];
  for await (const p of doc) pageBuffers.push(p as Buffer);
  const flat = await buildFlatField(pageBuffers);
  const mask = buildWatermarkMask(flat);
  console.log(`pages=${pageBuffers.length} flat=${flat ? `${flat.width}x${flat.height}` : 'null'}\n`);

  // OCR once per page (slow), cache word boxes + the cleaned (OCR-input) page.
  const worker = await createWorker('eng');
  const cleaned: Buffer[] = [];
  const wordBoxesByPage: OcrWordBox[][] = [];
  for (let i = 0; i < pageBuffers.length; i += 1) {
    const clean = await cleanPageImage(pageBuffers[i], flat);
    cleaned.push(clean);
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    wordBoxesByPage.push(collectWordBoxes(data));
    process.stdout.write(`\rOCR page ${i + 1}/${pageBuffers.length}`);
  }
  await worker.terminate();
  console.log('\n');

  const off = await segmentAll('PC off', false, pageBuffers, cleaned, wordBoxesByPage, flat, mask);
  const on = await segmentAll('PC on ', true, pageBuffers, cleaned, wordBoxesByPage, flat, mask);

  const expected = Number(process.env.OCR_EXPECTED_QUESTIONS) || null;
  const rOff = buildQualityReport(off.drafts, expected, off.traces);
  const rOn = buildQualityReport(on.drafts, expected, on.traces);

  const numsOff = [...new Set(off.drafts.map((d) => d.questionNumber).filter((n): n is number => n != null))].sort((a, b) => a - b);
  const numsOn = [...new Set(on.drafts.map((d) => d.questionNumber).filter((n): n is number => n != null))].sort((a, b) => a - b);

  let fieldDiffs = 0;
  const m = Math.max(off.drafts.length, on.drafts.length);
  for (let i = 0; i < m; i += 1) {
    if (sig(off.drafts[i] ?? ({} as any)) !== sig(on.drafts[i] ?? ({} as any))) fieldDiffs += 1;
  }

  console.log(`\n================ OCR IDENTITY ================`);
  console.log(`draft count ........ off=${off.drafts.length}  on=${on.drafts.length}  ${off.drafts.length === on.drafts.length ? 'IDENTICAL' : 'DIFF'}`);
  console.log(`detected ........... off=${rOff.detected}  on=${rOn.detected}  ${rOff.detected === rOn.detected ? 'IDENTICAL' : 'DIFF'}`);
  console.log(`coverage% .......... off=${rOff.coveragePct}  on=${rOn.coveragePct}  ${rOff.coveragePct === rOn.coveragePct ? 'IDENTICAL' : 'DIFF'}`);
  console.log(`missing ............ off=${rOff.missingNumbers.length}  on=${rOn.missingNumbers.length}  ${rOff.missingNumbers.length === rOn.missingNumbers.length ? 'IDENTICAL' : 'DIFF'}`);
  console.log(`invalidCrops ....... off=${rOff.invalidCrops}  on=${rOn.invalidCrops}  ${rOff.invalidCrops === rOn.invalidCrops ? 'IDENTICAL' : 'DIFF'}`);
  console.log(`questionNumbers .... ${JSON.stringify(numsOff) === JSON.stringify(numsOn) ? 'IDENTICAL' : 'DIFF'} (off=${numsOff.length} on=${numsOn.length})`);
  console.log(`per-draft field diffs (count/number/coords/optionCount/confidence/...): ${fieldDiffs}  ${fieldDiffs === 0 ? 'IDENTICAL' : '*** DIFF ***'}`);
  console.log(`\nVERDICT: ${off.drafts.length === on.drafts.length && rOff.detected === rOn.detected && rOff.coveragePct === rOn.coveragePct && JSON.stringify(numsOff) === JSON.stringify(numsOn) && fieldDiffs === 0 ? 'OCR OUTPUT IS IDENTICAL — persistentCore is display-only.' : 'DIFFERENCE DETECTED — investigate.'}`);
  console.log(`detected questionNumbers: [${numsOn.join(',')}]`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
