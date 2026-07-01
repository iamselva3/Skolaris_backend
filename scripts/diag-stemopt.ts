/* eslint-disable no-console */
/**
 * READ-ONLY investigation of the STEM-COLUMN + OPTION-COLUMN layout (one question whose
 * stem is in column 1 and whose A/B/C/D options are in column 2). For each page it reports
 * the spatial relationship between question markers (stem starts) and option labels:
 *  - stem-marker X distribution vs option-label X distribution (page-width %)
 *  - per stem region [marker.y .. nextMarker.y): how many of its options sit in the SAME
 *    x-column as the stem vs a column to the RIGHT (the tell-tale of a split layout)
 *  - vertical overlap between a stem band and a right-side option cluster
 * Purpose: confirm whether any reference PDF exhibits this layout, and measure the signals
 * a future associator would use. Modifies nothing; calls the engine read-only.
 *
 *   npx ts-node scripts/diag-stemopt.ts "<pdf>" ["<pdf>" ...]
 */
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import * as path from 'path';
import { buildFlatField, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import { detectQuestionPunct, findQuestionMarkers, medianHeight } from '../src/shared/ocr-engine/visual-segment';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';

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
const OPTION_RE = /^(?:\(?([A-Da-d])[.)]|\(([1-4])\))$/; // A) (A) A. (1)
const median = (a: number[]): number => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);

const main = async (): Promise<void> => {
  for (const file of process.argv.slice(2)) {
    const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
    const doc = await pdf(fs.readFileSync(file), { scale: 2 });
    const pages: Buffer[] = [];
    for await (const p of doc) pages.push(p as Buffer);
    const flat = await buildFlatField(pages);
    const worker = await createWorker('eng');
    console.log(`\n================ ${path.basename(file)} ================`);
    let splitPages = 0;

    for (let i = 0; i < pages.length; i += 1) {
      const W = (await sharp(pages[i]).metadata()).width ?? 1;
      const clean = await cleanPageImage(pages[i], flat);
      const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
      const words = collectWordBoxes(data);
      const mH = medianHeight(words);
      const qPunct = detectQuestionPunct(words, mH);
      const markers = findQuestionMarkers(words, mH, qPunct).sort((a, b) => a.y0 - b.y0);
      const options = words.filter((w) => OPTION_RE.test(w.text));
      if (markers.length === 0) continue;

      // For each stem region, classify its options as SAME-column (near stem.x) vs RIGHT.
      let sameCol = 0, rightCol = 0, regionsWithRightOnly = 0;
      for (let k = 0; k < markers.length; k += 1) {
        const m = markers[k];
        const yTop = m.y0, yBot = k + 1 < markers.length ? markers[k + 1].y0 : Number.POSITIVE_INFINITY;
        const opts = options.filter((o) => o.y0 >= yTop - mH && o.y0 < yBot);
        if (opts.length === 0) continue;
        const near = opts.filter((o) => o.x0 - m.x0 < W * 0.25).length; // within ~quarter-page of stem left
        const right = opts.length - near;
        sameCol += near; rightCol += right;
        if (right >= 2 && near === 0) regionsWithRightOnly += 1; // a stem whose options are ALL to the right
      }
      const stemX = Math.round((median(markers.map((m) => m.x0)) / W) * 100);
      const optX = Math.round((median(options.map((o) => o.x0)) / W) * 100);
      const split = regionsWithRightOnly >= 2; // ≥2 stems on the page with options only to the right
      if (split) splitPages += 1;
      console.log(
        `  p${i + 1}: stems=${markers.length} opts=${options.length} stemX=${stemX}% optX=${optX}% ` +
          `sameColOpts=${sameCol} rightColOpts=${rightCol} stems-with-right-only-options=${regionsWithRightOnly}` +
          `${split ? '  <<< STEM/OPTION-COLUMN SPLIT?' : ''}`,
      );
    }
    await worker.terminate();
    console.log(`  ── pages flagged as possible stem/option split: ${splitPages}/${pages.length}`);
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
