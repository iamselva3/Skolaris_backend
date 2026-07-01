/* eslint-disable no-console */
/** Column-detection report on the baseline PDFs — the make-or-break check: does the
 *  detector flag AD 2601 Q (must reflow) as confident multi-column while leaving
 *  RE NEET PST + Biology (must stay identical) as no-op? Read-only. */
import * as fs from 'fs';
import * as path from 'path';
import { detectColumns, REFLOW_CONFIDENCE, shouldReflow } from '../src/modules/ocr-preprocess/column-reflow';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

const main = async (): Promise<void> => {
  const files = process.argv.slice(2);
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  console.log(`reflow threshold = ${REFLOW_CONFIDENCE}\n`);
  for (const f of files) {
    try {
      const doc = await pdf(fs.readFileSync(f), { scale: 2 });
      const pages: Buffer[] = [];
      for await (const p of doc) pages.push(p as Buffer);
      let reflow = 0;
      const lines: string[] = [];
      for (let i = 0; i < pages.length; i += 1) {
        const lay = await detectColumns(pages[i]);
        const willReflow = shouldReflow(lay);
        if (willReflow) reflow += 1;
        lines.push(`  p${i + 1}: cols=${lay.columns} conf=${lay.confidence} ${willReflow ? 'REFLOW' : 'no-op'}  ${lay.reason}`);
      }
      console.log(`==== ${path.basename(f)} (${pages.length}p) — would reflow ${reflow}/${pages.length} ====`);
      console.log(lines.slice(0, 6).join('\n'));
      if (lines.length > 6) console.log(`  … (${lines.length - 6} more)`);
      console.log('');
    } catch (e) {
      console.log(`==== ${path.basename(f)} ERROR: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
