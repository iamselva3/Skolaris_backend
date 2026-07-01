/* eslint-disable no-console */
/**
 * DUAL-ENGINE PROOF (read-only, no DB/R2). Runs the REAL TS OCR engine (render → Tesseract → segmentation)
 * on a local PDF, then the TS paper analyzer (cross-page / cross-column / count hooks), and saves the TS
 * question crops to an output dir. Prints the TS question count so we can see whether TS alone reaches 180.
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/diag-dual-engine.ts "C:/Users/hp/Downloads/AIOTS 1 & DR09 Q @ sk_0476.pdf" "C:/Users/hp/Downloads/new3"
 */
import * as fs from 'fs';
import * as path from 'path';

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config();
} catch {
  /* env assumed pre-populated */
}

import { extractDrafts } from '../src/shared/ocr-engine/ocr-engine';

async function main(): Promise<void> {
  const pdf = process.argv[2] || 'C:/Users/hp/Downloads/AIOTS 1 & DR09 Q @ sk_0476.pdf';
  const outDir = process.argv[3] || 'C:/Users/hp/Downloads/new3';
  if (!fs.existsSync(pdf)) {
    console.log('PDF not found:', pdf);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const bytes = fs.readFileSync(pdf);
  console.log(`running TS engine on ${path.basename(pdf)} (${(bytes.length / 1048576).toFixed(1)}MB) …`);

  let saved = 0;
  const t0 = Date.now();
  const result = await extractDrafts(bytes, 'application/pdf', {
    withWords: true,
    figureKeyPrefix: 'diag',
    putObject: async (key: string, body: Buffer): Promise<void> => {
      const name = key.split('/').pop() || `crop_${saved}.png`;
      fs.writeFileSync(path.join(outDir, name), body);
      saved += 1;
    },
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);

  const drafts = result.drafts as Array<{ questionNumber?: number | null }>;
  const nums = drafts
    .map((d) => d.questionNumber)
    .filter((n): n is number => typeof n === 'number' && n >= 1)
    .sort((a, b) => a - b);
  const distinct = Array.from(new Set(nums));
  console.log('============================================================');
  console.log(`TS ENGINE: drafts=${drafts.length}  crops_saved=${saved}  time=${secs}s`);
  console.log(`numbered drafts=${nums.length}  distinct=${distinct.length}  range=${distinct[0] ?? '-'}..${distinct[distinct.length - 1] ?? '-'}`);
  if (distinct.length) {
    const lo = distinct[0];
    const hi = distinct[distinct.length - 1];
    const missing = [];
    for (let n = lo; n <= hi; n += 1) if (!distinct.includes(n)) missing.push(n);
    console.log(`missing within range (${lo}..${hi}): ${missing.length} -> [${missing.join(', ')}]`);
  }
  console.log(`pages OCR'd=${result.analysisPageImages?.length ?? '-'}  output -> ${outDir}`);
  console.log('============================================================');
}

main().catch((e) => {
  console.error('ERROR:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
