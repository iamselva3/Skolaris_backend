/*
 * Run the REAL OCR engine (extractDrafts: render -> clean -> tesseract -> segment) on each baseline PDF
 * and dump a capture (good TS tokens + raw renders) per paper, so the Python analyzer can be regression-
 * tested on every layout — not just RE NEET. Also prints the TS-side detected/marker summary per paper.
 *
 *   npx ts-node --transpile-only scripts/diag-extract-baselines.ts
 */
import * as fs from 'fs';
import { extractDrafts } from '../src/shared/ocr-engine/ocr-engine';
import type { OcrWordBox } from '../src/shared/ocr-engine/column-reorder';

const DL = 'C:/Users/hp/Downloads';
const PAPERS: Array<{ name: string; pdf: string }> = [
  { name: 'biology', pdf: `${DL}/Biology.pdf` },
  { name: 'biology_cell', pdf: `${DL}/Biology_Cell.pdf` },
  { name: 'phyche', pdf: `${DL}/PHYCHE.pdf` },
  { name: 'ad2601', pdf: `${DL}/AD 2601 Q.pdf` },
  { name: 'aiots_dr09', pdf: `${DL}/AIOTS 1 & DR09 Q @ sk_0476.pdf` },
  { name: '25rep', pdf: `${DL}/25 REP @ sk.pdf` },
];

const MARK = /^(\d{1,3})[.,:;)]/;
function distinctMarkers(wordsByPage: OcrWordBox[][]): number {
  const s = new Set<number>();
  for (const page of wordsByPage || []) {
    if (!page) continue;
    const pw = Math.max(1, ...page.map((w) => w.x1));
    for (const w of page) {
      const m = MARK.exec((w.text || '').trim());
      if (!m || (w.text || '').startsWith('(')) continue;
      const n = Number(m[1]);
      const fx = w.x0 / pw;
      if (n >= 1 && n <= 300 && (fx < 0.18 || (fx > 0.45 && fx < 0.64))) s.add(n);
    }
  }
  return s.size;
}

async function main() {
  fs.mkdirSync('tmp/baselines', { recursive: true });
  for (const p of PAPERS) {
    if (!fs.existsSync(p.pdf)) {
      process.stderr.write(`SKIP ${p.name}: not found\n`);
      continue;
    }
    if (fs.existsSync(`tmp/baselines/${p.name}.tokens.json`)) {
      process.stderr.write(`SKIP ${p.name}: already captured\n`);
      continue;
    }
    const bytes = fs.readFileSync(p.pdf);
    let crops = 0;
    const t0 = Date.now();
    try {
      const res = await extractDrafts(bytes, 'application/pdf', {
        putObject: async () => { crops += 1; },
        figureKeyPrefix: 'diag',
      });
      const awp = res.analysisWordsByPage || [];
      const imgs = (res as any).analysisPageImages as Buffer[] | undefined;
      const pages = awp.map((words, i) => ({
        index: i + 1, width: 0, height: 0,
        words: (words || []).map((w) => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 })),
        imageBase64: imgs && imgs[i] ? imgs[i].toString('base64') : undefined,
      }));
      fs.writeFileSync(`tmp/baselines/${p.name}.tokens.json`, JSON.stringify({ documentId: p.name, pages }));
      process.stderr.write(
        `${p.name.padEnd(14)} pages=${pages.length} tsDrafts=${res.drafts?.length ?? 0} ` +
          `analysisMarkers=${distinctMarkers(awp)} crops=${crops} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`,
      );
    } catch (e) {
      process.stderr.write(`${p.name} ERROR: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  process.stderr.write('done -> tmp/baselines/*.tokens.json\n');
}
main().catch((e) => { console.error(e); process.exit(1); });
