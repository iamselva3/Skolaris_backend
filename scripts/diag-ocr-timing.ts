/*
 * READ-ONLY diagnostic for the OCR startup-latency investigation.
 *
 * Pulls REAL (measured, not estimated) numbers for a given upload:
 *   - original upload size            (uploads.size_bytes)
 *   - CURRENT stored object size      (R2 HeadObject ContentLength) → file growth
 *   - OCR job total latency           (ocr_jobs.started_at → finished_at)
 *   - per-page OCR timing             (ocr_page_checkpoints.created_at deltas, if retained)
 *
 * Nothing is written. Nothing is re-dispatched. Safe to run against the live DB/R2.
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/diag-ocr-timing.ts "2601"
 *   (arg = case-insensitive substring of uploads.original_name; defaults to "2601")
 */
import { PrismaClient } from '@prisma/client';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';

// Load .env (dotenv ships transitively with @nestjs/config).
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config();
} catch {
  /* if dotenv is unavailable the process env is assumed to be pre-populated */
}

const MB = (n: number | bigint | null | undefined): string =>
  n == null ? 'n/a' : `${(Number(n) / 1024 / 1024).toFixed(2)} MB`;
const secs = (a?: Date | null, b?: Date | null): string =>
  a && b ? `${((b.getTime() - a.getTime()) / 1000).toFixed(1)}s` : 'n/a';

async function headSize(key: string): Promise<{ size: number | null; lastModified?: Date }> {
  const region = process.env.AWS_REGION ?? 'auto';
  const client = new S3Client({
    region,
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials:
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
  });
  try {
    const r = await client.send(
      new HeadObjectCommand({ Bucket: process.env.AWS_S3_BUCKET ?? '', Key: key }),
    );
    return { size: r.ContentLength ?? null, lastModified: r.LastModified };
  } catch (e) {
    console.log(`  ! HeadObject failed for ${key}: ${(e as Error).message}`);
    return { size: null };
  }
}

async function main(): Promise<void> {
  const needle = (process.argv[2] ?? '2601').trim();
  const prisma = new PrismaClient();
  try {
    const uploads = await prisma.upload.findMany({
      where: { originalName: { contains: needle, mode: 'insensitive' } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    if (uploads.length === 0) {
      console.log(`No uploads matching "${needle}".`);
      return;
    }
    console.log(`\nMatched ${uploads.length} upload(s) for "${needle}" (newest first):\n`);
    for (const u of uploads) {
      console.log('═'.repeat(72));
      console.log(`upload      : ${u.originalName}  [${u.id}]`);
      console.log(`status      : ${u.status}   mime: ${u.mimeType}`);
      console.log(`created     : ${u.createdAt.toISOString()}`);
      console.log(`storageKey  : ${u.storageKey}`);
      console.log(`ocrMeta     : ${u.ocrMeta ? JSON.stringify(u.ocrMeta) : 'null'}`);

      const head = await headSize(u.storageKey);
      const orig = u.sizeBytes != null ? Number(u.sizeBytes) : null;
      console.log('\n── FILE GROWTH (Q1) ──');
      console.log(`  original upload size (db)   : ${MB(orig)}  (${orig ?? '?'} bytes)`);
      console.log(
        `  current stored size (R2 head): ${MB(head.size)}  (${head.size ?? '?'} bytes)` +
          (head.lastModified ? `  lastModified=${head.lastModified.toISOString()}` : ''),
      );
      if (orig != null && head.size != null) {
        const delta = head.size - orig;
        const pct = orig > 0 ? ((delta / orig) * 100).toFixed(0) : '?';
        console.log(`  delta                        : ${delta >= 0 ? '+' : ''}${MB(delta)}  (${delta >= 0 ? '+' : ''}${pct}%)`);
        console.log(
          `  NOTE: current size is POST-cleanup (Node overwrites the same key after /cleanup).`,
        );
      }

      const job = await prisma.ocrJob.findUnique({ where: { uploadId: u.id } });
      console.log('\n── OCR JOB LATENCY (Q3) ──');
      if (!job) {
        console.log('  (no ocr_job row)');
      } else {
        console.log(`  job id        : ${job.id}`);
        console.log(`  status        : ${job.status}   provider: ${job.providerUsed ?? 'n/a'}`);
        console.log(`  totalPages    : ${job.totalPages ?? 'n/a'}   lastCompletedPage: ${job.lastCompletedPage}   attempts: ${job.attemptCount}`);
        console.log(`  queuedAt      : ${job.queuedAt?.toISOString() ?? 'n/a'}`);
        console.log(`  startedAt     : ${job.startedAt?.toISOString() ?? 'n/a'}`);
        console.log(`  finishedAt    : ${job.finishedAt?.toISOString() ?? 'n/a'}`);
        console.log(`  queue→start   : ${secs(job.queuedAt, job.startedAt)}`);
        console.log(`  start→finish  : ${secs(job.startedAt, job.finishedAt)}   ◀ TOTAL OCR latency`);
        console.log(`  progress      : ${job.progress ? JSON.stringify(job.progress) : 'null'}`);
        if (job.errorMessage) console.log(`  errorMessage  : ${job.errorMessage}`);

        // Per-page checkpoint timing (only retained while a job is PAUSED/incomplete;
        // cleared on COMPLETED). created_at deltas ≈ per-page OCR cost.
        const cps = await prisma.ocrPageCheckpoint.findMany({
          where: { ocrJobId: job.id },
          orderBy: { pageNumber: 'asc' },
          select: { pageNumber: true, createdAt: true, updatedAt: true },
        });
        console.log(`\n── PER-PAGE OCR TIMING (from ${cps.length} checkpoint rows) ──`);
        if (cps.length === 0) {
          console.log('  (none retained — job likely COMPLETED, which clears checkpoints)');
        } else {
          let prev: Date | null = null;
          for (const c of cps) {
            const d = prev ? `${((c.createdAt.getTime() - prev.getTime()) / 1000).toFixed(1)}s` : '—';
            console.log(`  page ${String(c.pageNumber).padStart(2)} : ${c.createdAt.toISOString()}  Δprev=${d}`);
            prev = c.createdAt;
          }
        }
      }
      console.log('');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
