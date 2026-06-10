/* eslint-disable no-console */
/**
 * Output-identity verifier for OCR_PARALLEL_PAGES — ALL in ONE process (one
 * ts-node cold start; the single worker + the pool are each created once and
 * reused across PDFs). For each PDF it runs the REAL engine at parallel=1 and
 * parallel=4 and compares a normalized per-draft projection (position, page,
 * questionNumber, crop coordinates, type, AND each crop's byte hash). The random
 * crop-key UUID suffix (visual-segment.ts) is normalized out — it is random on
 * every run and is not OCR output. process.exit at the end so live Tesseract
 * worker threads can't keep the process alive.
 *
 *   npx ts-node scripts/diag-parallel-verify-all.ts "<pdf1>" "<pdf2>" ...
 */
import * as fs from 'fs';
import * as crypto from 'crypto';
import { extractDrafts } from '../src/shared/ocr-engine/ocr-engine';

const sha = (b: Buffer | string): string =>
  crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);

const projection = async (bytes: Buffer, parallel: number): Promise<{ body: string; head: string }> => {
  process.env.OCR_PARALLEL_PAGES = String(parallel);
  const crops = new Map<string, string>();
  const result = await extractDrafts(bytes, 'application/pdf', {
    putObject: async (key: string, body: Buffer) => {
      crops.set(key, `${body.length}:${sha(body)}`);
    },
    figureKeyPrefix: 'verify',
    storageKey: 'verify.pdf',
  });
  const lines = result.drafts.map((d) => {
    const c = d.sourceCoordinates;
    const coords = c ? `${c.x0},${c.y0},${c.x1},${c.y1}` : '-';
    const cropHash = d.questionSnapshotKey ? (crops.get(d.questionSnapshotKey) ?? 'MISSING') : '-';
    const cropKey = (d.questionSnapshotKey ?? '-').replace(/-[0-9a-f]{8}\.png$/, '-RND.png');
    return [
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
    ].join(' | ');
  });
  const qnums = [
    ...new Set(result.drafts.map((d) => d.questionNumber).filter((n): n is number => n != null)),
  ].sort((a, b) => a - b);
  return {
    body: lines.join('\n'),
    head: `drafts=${result.drafts.length} distinctQ=${qnums.length} crops=${crops.size} qnums=[${qnums.join(',')}]`,
  };
};

const main = async (): Promise<void> => {
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error('pass one or more PDF paths');
  let allOk = true;
  for (const file of files) {
    const name = file.split(/[\\/]/).pop();
    if (!fs.existsSync(file)) {
      console.log(`✗ ${name}: NOT FOUND`);
      allOk = false;
      continue;
    }
    const bytes = fs.readFileSync(file);
    const a = await projection(bytes, 1);
    const b = await projection(bytes, 4);
    const ok = a.body === b.body && a.head === b.head;
    if (!ok) allOk = false;
    console.log(`${ok ? '✓ IDENTICAL' : '✗ DIFFERS  '}  ${name}`);
    console.log(`     p1: ${a.head}`);
    console.log(`     p4: ${b.head}`);
    if (!ok) {
      const al = a.body.split('\n');
      const bl = b.body.split('\n');
      for (let i = 0; i < Math.max(al.length, bl.length); i += 1) {
        if (al[i] !== bl[i]) {
          console.log(`     first diff @line ${i}:\n       p1: ${al[i] ?? '(none)'}\n       p4: ${bl[i] ?? '(none)'}`);
          break;
        }
      }
    }
  }
  console.log(allOk ? '\n==== ALL IDENTICAL ✓ ====' : '\n==== MISMATCH ✗ ====');
  process.exit(allOk ? 0 : 1);
};

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
