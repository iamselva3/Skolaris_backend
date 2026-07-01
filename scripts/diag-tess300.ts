/*
 * VALIDATION: does Tesseract (the platform OCR, tesseract.js) at 300 DPI recover the
 * scanned question numbers the ~150 DPI capture lost? Baseline = 142/180 distinct markers.
 *
 * Renders are pre-made PNGs (tmp/reneet300/p01.png ...). For each page we OCR with the SAME
 * call production uses (recognize(img, {}, { blocks: true })), pull word boxes, and count
 * distinct question-number markers 1..180 at the column-left margin.
 *
 *   npx ts-node --transpile-only scripts/diag-tess300.ts tmp/reneet300
 */
import * as fs from 'fs';
import * as path from 'path';
import { createWorker } from 'tesseract.js';

const MARK = /^\(?(\d{1,3})[.)]/; // "12." or "12)" or "(12)"

interface W { text: string; x0: number; y0: number; x1: number; y1: number; }

function words(data: any): W[] {
  const out: W[] = [];
  for (const b of data.blocks ?? [])
    for (const p of b.paragraphs ?? [])
      for (const l of p.lines ?? [])
        for (const w of l.words ?? []) {
          if (w?.text && w.bbox) out.push({ text: w.text, ...w.bbox });
        }
  return out;
}

async function main() {
  const dir = process.argv[2] || 'tmp/reneet300';
  const files = fs.readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort();
  const worker = await createWorker('eng', 1, { logger: () => {} });

  const found = new Map<number, { page: number; x: number; text: string }>();
  const perPage: Record<string, number[]> = {};
  for (const f of files) {
    const img = fs.readFileSync(path.join(dir, f));
    const { data } = (await worker.recognize(img, {}, { blocks: true } as any)) as any;
    const ws = words(data);
    const pageW = Math.max(1, ...ws.map((w) => w.x1));
    const here: number[] = [];
    for (const w of ws) {
      const m = MARK.exec(w.text.trim());
      if (!m) continue;
      const n = Number(m[1]);
      if (n < 1 || n > 180) continue;
      // column-left margin gate: left column (<14% width) OR right column (48%-62% width).
      // Question markers hug a column's left edge; in-body numbers / option "(1)" mostly don't.
      const fx = w.x0 / pageW;
      const isMarker = w.text.includes('.') && !w.text.startsWith('(');
      const leftish = fx < 0.14 || (fx > 0.47 && fx < 0.62);
      if (isMarker && leftish) {
        here.push(n);
        if (!found.has(n)) found.set(n, { page: Number(f.replace(/\D/g, '')), x: Math.round(w.x0), text: w.text });
      }
    }
    perPage[f] = [...new Set(here)].sort((a, b) => a - b);
    process.stderr.write(`${f}: ${perPage[f].join(',')}\n`);
  }
  await worker.terminate();

  const distinct = [...found.keys()].sort((a, b) => a - b);
  const missing = [];
  for (let n = 1; n <= 180; n++) if (!found.has(n)) missing.push(n);
  process.stderr.write(`\n=== TESSERACT @300DPI ===\n`);
  process.stderr.write(`distinct question markers 1..180: ${distinct.length}/180\n`);
  process.stderr.write(`missing (${missing.length}): ${missing.join(',')}\n`);
  process.stderr.write(`baseline capture had 142 (38 missing). DELTA = ${distinct.length - 142}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
