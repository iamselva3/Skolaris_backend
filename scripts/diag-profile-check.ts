/* eslint-disable no-console */
/**
 * READ-ONLY end-to-end check of the DOCUMENT-DRIVEN profile wiring. Runs the REAL engine
 * (extractDrafts → ocrPdf, which now computes a DocumentProfile and feeds the watermark mask)
 * on a PDF and reports: the derived profile (printed by the engine) + the final draft count.
 * Used to prove the document-driven thresholds do NOT regress the validated counts (RE NEET 180).
 *
 *   npx ts-node scripts/diag-profile-check.ts "<pdf>"
 */
import * as fs from 'fs';
import * as path from 'path';
import { extractDrafts } from '../src/shared/ocr-engine/ocr-engine';

const run = async (file: string): Promise<void> => {
  if (!fs.existsSync(file)) { console.error(`PDF not found: ${file}`); process.exit(2); }
  const bytes = fs.readFileSync(file);
  const store = new Map<string, Buffer>();
  const putObject = async (key: string, body: Buffer): Promise<void> => { store.set(key, body); };
  const result = await extractDrafts(bytes, 'application/pdf', {
    putObject,
    figureKeyPrefix: 'tenants/t/ocr-figures/job',
  });
  const withNum = result.drafts.filter((d) => (d.questionNumber ?? null) !== null).length;
  console.log(`\n==== PROFILE CHECK — ${path.basename(file)} ====`);
  console.log(`drafts=${result.drafts.length} withNumber=${withNum} provider=${result.providerUsed}`);
};
run(process.argv[2] ?? 'fixtures/sample-paper.pdf').catch((e) => { console.error(e); process.exit(1); });
