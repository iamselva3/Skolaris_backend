/* eslint-disable no-console */
/**
 * Dump OCR word boxes around the known gap regions (Q103, Q108, Q111) so the
 * recovery strategy is based on what tesseract ACTUALLY emitted — absent,
 * garbled, or glued — not on assumption. Mirrors the diag-ocr pipeline.
 */
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import * as fs from 'fs';
import { buildFlatField, cleanPageImage } from '../src/shared/ocr-engine/watermark-clean';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';

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
  const bytes = fs.readFileSync(file);
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(bytes, { scale: 2 });
  const pageBuffers: Buffer[] = [];
  for await (const p of doc) pageBuffers.push(p as Buffer);
  const flat = await buildFlatField(pageBuffers);
  const worker = await createWorker('eng');

  // numbers to find, passed via argv (comma list); dump those tokens on each page.
  const want = (process.argv[3] ?? '169,170,171,172,270').split(',').map((s) => Number(s.trim()));
  const pageList = (process.argv[4] ?? '1').split(',').map((s) => Number(s.trim()));
  const targets: Record<number, number[]> = {};
  for (const pg of pageList) targets[pg] = want;

  for (const pageIdx of pageList) {
    const raw = pageBuffers[pageIdx - 1];
    const clean = await cleanPageImage(raw, flat);
    const meta = await sharp(clean).metadata();
    const pw = meta.width ?? 0;
    const { data } = await worker.recognize(clean, {}, { blocks: true } as any);
    const words = collectWordBoxes(data);
    const anchors = words.filter((w) => {
      const n = /^(\d{1,3})/.exec(w.text);
      return n && targets[pageIdx].includes(+n[1]);
    });
    console.log(`\n================ PAGE ${pageIdx} (width=${pw}) ================`);
    console.log(`anchors:`, anchors.map((a) => `${a.text}@(${a.x0},${a.y0})`).join('  '));
    if (anchors.length === 0) continue;
    const yLo = Math.min(...anchors.map((a) => a.y0)) - 20;
    const yHi = Math.max(...anchors.map((a) => a.y1)) + 20;
    // Every token in the anchored y-band, sorted reading order, with box.
    const band = words
      .filter((w) => w.y1 >= yLo && w.y0 <= yHi)
      .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    console.log(`--- all tokens in y=[${yLo},${yHi}] (col split ~x=${Math.round(pw / 2)}) ---`);
    let lastY = -999;
    let line: string[] = [];
    const flush = (): void => {
      if (line.length) console.log('  ' + line.join('  '));
      line = [];
    };
    for (const w of band) {
      if (w.y0 - lastY > 12) {
        flush();
      }
      line.push(`${w.text}@(${w.x0},${w.y0})`);
      lastY = w.y0;
    }
    flush();
    // Explicitly: any token containing a digit in this band
    console.log(`--- digit tokens in band ---`);
    for (const w of band)
      if (/\d/.test(w.text)) console.log(`  "${w.text}" x0=${w.x0} y0=${w.y0} x1=${w.x1} y1=${w.y1}`);
  }
  await worker.terminate();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
