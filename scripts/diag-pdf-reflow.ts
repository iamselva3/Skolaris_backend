/* eslint-disable no-console */
/**
 * Integration check for the preprocess PDF rebuild (reflowPdf). For each PDF:
 *  - prints changed / pageCount / reflowedPages + per-page action summary
 *  - if changed, re-renders the REBUILT PDF to confirm it is a valid, readable PDF with
 *    the same page count (proves the engine will be able to render it).
 * NO-OP papers must report changed:false ⇒ the caller leaves the original untouched ⇒
 * byte-identical input to the unchanged OCR pipeline.
 *
 *   npx ts-node scripts/diag-pdf-reflow.ts "<pdf>" ["<pdf>" ...]
 */
import * as fs from 'fs';
import * as path from 'path';
import { reflowPdf } from '../src/modules/ocr-preprocess/pdf-reflow';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
const renderCount = async (bytes: Buffer): Promise<number> => {
  const { pdf } = (await esmImport('pdf-to-img')) as { pdf: any };
  const doc = await pdf(bytes, { scale: 2 });
  let n = 0;
  for await (const _ of doc) n += 1;
  return n;
};

const main = async (): Promise<void> => {
  for (const f of process.argv.slice(2)) {
    try {
      const bytes = fs.readFileSync(f);
      const r = await reflowPdf(bytes);
      console.log(`\n==== ${path.basename(f)} ====`);
      console.log(`  changed=${r.changed} pages=${r.pageCount} reflowed=${r.reflowedPages}`);
      const reflowedList = r.summary.filter((s) => s.action === 'reflow').map((s) => `p${s.page}(${s.confidence})`);
      console.log(`  reflow pages: ${reflowedList.length ? reflowedList.join(', ') : '(none)'}`);
      if (r.changed && r.pdf) {
        const n = await renderCount(r.pdf);
        const ok = n === r.pageCount;
        console.log(`  REBUILT pdf: ${r.pdf.length}B, re-renders ${n}/${r.pageCount} pages ${ok ? '✅ valid' : '*** PAGE COUNT MISMATCH ***'}`);
      } else {
        console.log('  NO-OP → original object untouched (identical) ✅');
      }
    } catch (e) {
      console.log(`\n==== ${path.basename(f)} ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
