/* eslint-disable no-console */
/**
 * Output-identity verifier for the OCR_PARALLEL_PAGES scheduling change. Runs the
 * REAL engine (extractDrafts → ocrPdf) on a PDF and writes a deterministic
 * per-draft projection (position, page, questionNumber, crop coordinates, type,
 * AND a hash of every crop's bytes) to a file. Run it once with
 * OCR_PARALLEL_PAGES=1 and once with >1, then diff the two files — they must be
 * byte-identical.
 *
 *   $env:OCR_PARALLEL_PAGES=1; npx ts-node scripts/diag-parallel-verify.ts "<pdf>" out1.txt
 *   $env:OCR_PARALLEL_PAGES=4; npx ts-node scripts/diag-parallel-verify.ts "<pdf>" out4.txt
 */
import * as fs from 'fs';
import * as crypto from 'crypto';
import { extractDrafts } from '../src/shared/ocr-engine/ocr-engine';

const sha = (b: Buffer | string): string =>
  crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);

const main = async (): Promise<void> => {
  const file = process.argv[2];
  const outPath = process.argv[3] ?? 'verify-out.txt';
  if (!file || !fs.existsSync(file)) throw new Error(`PDF not found: ${file}`);
  const bytes = fs.readFileSync(file);

  // Capture every crop's bytes by key so crop boundaries/content are compared.
  const crops = new Map<string, string>();
  const putObject = async (key: string, body: Buffer): Promise<void> => {
    crops.set(key, `${body.length}:${sha(body)}`);
  };

  const result = await extractDrafts(bytes, 'application/pdf', {
    putObject,
    figureKeyPrefix: 'verify',
    storageKey: 'verify.pdf',
  });

  const drafts = result.drafts;
  const lines: string[] = [];
  for (const d of drafts) {
    const c = d.sourceCoordinates;
    const coords = c ? `${c.x0},${c.y0},${c.x1},${c.y1}` : '-';
    // The crop key ends in a per-crop randomUUID slice (visual-segment.ts) that
    // is random EVERY run (independent of OCR_PARALLEL_PAGES) — normalize it out
    // so the comparison reflects OCR output, not the random filename. The crop's
    // byte content + coordinates (compared below) are what must be identical.
    const cropHash = d.questionSnapshotKey ? (crops.get(d.questionSnapshotKey) ?? 'MISSING') : '-';
    const cropKey = (d.questionSnapshotKey ?? '-').replace(/-[0-9a-f]{8}\.png$/, '-RND.png');
    lines.push(
      [
        `pos=${d.position}`,
        `page=${d.sourcePageNumber ?? '-'}`,
        `span=${d.spanPageStart ?? '-'}..${d.spanPageEnd ?? '-'}`,
        `qnum=${d.questionNumber ?? 'null'}`,
        `type=${d.detectedType}`,
        `class=${d.questionClass ?? '-'}`,
        `opt=${d.optionCount ?? '-'}`,
        `invalid=${d.invalidCrop ? 1 : 0}`,
        `needsReview=${d.needsImageReview ? 1 : 0}`,
        `coords=${coords}`,
        `textSha=${sha(d.text ?? '')}`,
        `cropKey=${cropKey}`,
        `crop=${cropHash}`,
      ].join(' | '),
    );
  }

  const qnums = [...new Set(drafts.map((d) => d.questionNumber).filter((n): n is number => n != null))].sort(
    (a, b) => a - b,
  );
  const header = [
    `FILE=${file.split(/[\\/]/).pop()}`,
    `PARALLEL=${process.env.OCR_PARALLEL_PAGES ?? '1'}`,
    `provider=${result.providerUsed}`,
    `draftCount=${drafts.length}`,
    `distinctQNumbers=${qnums.length}`,
    `qnums=[${qnums.join(',')}]`,
    `crops=${crops.size}`,
  ].join('\n');

  fs.writeFileSync(outPath, header + '\n----\n' + lines.join('\n') + '\n');
  console.log(`[verify] wrote ${outPath}`);
  console.log(header);
  console.log(`[verify] projection-digest=${sha(lines.join('\n'))}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
