/*
 * RAW vs CLEANED render OCR recall, per baseline. Each capture stores the RAW render (imageBase64) plus
 * the words OCR'd from the CLEANED page (cleanPageImage). So: markers in stored words = CLEANED recall;
 * markers in tesseract.js OCR of imageBase64 = RAW recall. Decides whether OCR-on-raw is a net win.
 *
 *   npx ts-node --transpile-only scripts/diag-raw-vs-clean.ts ad2601 reneet_good ...
 */
import * as fs from 'fs';
import { createWorker } from 'tesseract.js';

const MARK = /^(\d{1,3})[.,:;)]/;
function markersOf(words: Array<{ text: string; x0: number; x1: number }>): Set<number> {
  const pw = Math.max(1, ...words.map((w) => w.x1));
  const s = new Set<number>();
  for (const w of words) {
    const m = MARK.exec((w.text || '').trim());
    if (!m || (w.text || '').startsWith('(')) continue;
    const n = Number(m[1]);
    const fx = w.x0 / pw;
    if (n >= 1 && n <= 300 && (fx < 0.18 || (fx > 0.45 && fx < 0.64))) s.add(n);
  }
  return s;
}
function collect(data: any) {
  const out: Array<{ text: string; x0: number; x1: number }> = [];
  for (const b of data.blocks ?? [])
    for (const p of b.paragraphs ?? [])
      for (const l of p.lines ?? [])
        for (const w of l.words ?? []) if (w?.text && w.bbox) out.push({ text: w.text, x0: w.bbox.x0, x1: w.bbox.x1 });
  return out;
}

async function main() {
  const names = process.argv.slice(2);
  const worker = await createWorker('eng', 1, { logger: () => {} });
  for (const name of names) {
    const path = name.includes('/') ? name : `tmp/baselines/${name}.tokens.json`;
    const real = fs.existsSync(path) ? path : `tmp/${name}.tokens.json`;
    if (!fs.existsSync(real)) { process.stderr.write(`SKIP ${name}: no capture\n`); continue; }
    const cap = JSON.parse(fs.readFileSync(real, 'utf-8'));
    const cleanedAll: any[] = [];
    const rawAll: any[] = [];
    for (const p of cap.pages) {
      cleanedAll.push(...(p.words || []));
      if (!p.imageBase64) continue;
      const { data } = (await worker.recognize(Buffer.from(p.imageBase64, 'base64'), {}, { blocks: true } as any)) as any;
      rawAll.push(...collect(data));
    }
    const cleaned = markersOf(cleanedAll);
    const raw = markersOf(rawAll);
    const rawOnly = [...raw].filter((n) => !cleaned.has(n)).sort((a, b) => a - b);
    const cleanedOnly = [...cleaned].filter((n) => !raw.has(n)).sort((a, b) => a - b);
    process.stderr.write(
      `${name.padEnd(14)} CLEANED=${cleaned.size}  RAW=${raw.size}  ` +
        `raw-only(+${rawOnly.length})=${JSON.stringify(rawOnly.slice(0, 12))}  ` +
        `cleaned-only(+${cleanedOnly.length})=${JSON.stringify(cleanedOnly.slice(0, 12))}\n`,
    );
  }
  await worker.terminate();
}
main().catch((e) => { console.error(e); process.exit(1); });
