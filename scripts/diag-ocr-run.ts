/*
 * REAL measurement harness for OCR startup latency. Runs the ACTUAL pre-OCR +
 * OCR stages (the exact DI-free functions the production runner calls) over the
 * already-uploaded R2 bytes, timing each stage and sampling memory. NO OcrJob/
 * draft DB writes; figure crops go to a throwaway DIAG prefix that is deleted at
 * the end. The delivery/analysis stage runs AFTER OCR (irrelevant to "delay
 * before OCR starts") and needs the full Nest DI graph, so it is intentionally
 * not measured here — production measures it via the [ocr-timing] deliver_complete log.
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/diag-ocr-run.ts "2601"
 *   (arg = case-insensitive substring of uploads.original_name; defaults to "2601")
 *
 * Stages timed (mirrors src/shared/workers/ocr-job-runner.service.ts):
 *   storage_read  → GetObject                                   (line ~203)
 *   cleanup       → decideCleanupOwner + dispatchCleanupHttp    (lines ~260-288)
 *   extract       → resolveDrafts → extractDrafts (render+OCR)  (line ~306)
 */
import { PrismaClient } from '@prisma/client';
import { GetObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  readCleanupSettings,
  decideCleanupOwner,
  dispatchCleanupHttp,
} from '../src/shared/ocr-engine/cleanup-http';
import { readHandwritingSettings, resolveDrafts } from '../src/shared/ocr-engine/resolve-drafts';

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config();
} catch {
  /* env assumed pre-populated */
}

const MB = (n: number): string => `${(n / 1024 / 1024).toFixed(2)} MB`;
const now = (): number => Number(process.hrtime.bigint() / 1_000_000n);
const rss = (): number => process.memoryUsage().rss;
const heap = (): number => process.memoryUsage().heapUsed;

function s3(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION ?? 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials:
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
        : undefined,
  });
}
const BUCKET = process.env.AWS_S3_BUCKET ?? '';

async function main(): Promise<void> {
  const needle = (process.argv[2] ?? '2601').trim();
  const prisma = new PrismaClient();
  const client = s3();
  const putKeys: string[] = [];
  let peakRss = rss();
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, rss());
  }, 200);

  try {
    const upload = await prisma.upload.findFirst({
      where: { originalName: { contains: needle, mode: 'insensitive' }, status: { not: 'PENDING_UPLOAD' } },
      orderBy: { createdAt: 'desc' },
    });
    if (!upload) {
      console.log(`No completed upload matching "${needle}".`);
      return;
    }
    const mime = upload.mimeType || 'application/pdf';
    console.log('═'.repeat(72));
    console.log(`MEASURING: ${upload.originalName}  [${upload.id}]`);
    console.log(`storageKey: ${upload.storageKey}`);
    console.log(`db size   : ${MB(Number(upload.sizeBytes ?? 0))}   mime: ${mime}`);
    console.log(`mem(start): rss=${MB(rss())} heap=${MB(heap())}`);
    console.log('═'.repeat(72));

    // ── STAGE 1: storage_read (GetObject) ──
    const t1 = now();
    const obj = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: upload.storageKey }));
    const bytes = Buffer.from(await obj.Body!.transformToByteArray());
    const tStorage = now() - t1;
    console.log(`\n[1] storage_read  : ${tStorage} ms   bytes=${MB(bytes.length)}   rss=${MB(rss())}`);

    // ── STAGE 2: cleanup (decide owner + Python sidecar dispatch) ──
    let ocrBody: Buffer = bytes;
    const cs = readCleanupSettings();
    console.log(`\n[2] cleanup       : enabled=${cs.enabled} url=${cs.serviceUrl ?? 'none'} timeout=${cs.timeoutMs}ms`);
    if (cs.enabled && cs.serviceUrl) {
      const tOwner = now();
      const owner = await decideCleanupOwner(ocrBody, mime, upload.storageKey);
      console.log(`    decideOwner   : ${now() - tOwner} ms   owner=${owner}  (profilePdf classified the doc)`);
      if (owner === 'python' || owner === 'python+sharp') {
        const tClean = now();
        const memBefore = rss();
        const res = await dispatchCleanupHttp(
          { ocrJobId: 'diag', storageKey: upload.storageKey, mime, owner },
          { serviceUrl: cs.serviceUrl, timeoutMs: cs.timeoutMs },
        );
        const cleanMs = now() - tClean;
        console.log(`    /cleanup RPC  : ${cleanMs} ms   result=${res === null ? 'NULL (failed/circuit/keep-original)' : `changed=${res.changed}`}`);
        if (res?.changed && res.bytes) {
          console.log(`    out size      : ${MB(res.bytes.length)}  (in ${MB(ocrBody.length)}, delta ${MB(res.bytes.length - ocrBody.length)})`);
          ocrBody = res.bytes; // NOTE: harness does NOT write back to storage
        } else {
          console.log(`    out size      : unchanged (${MB(ocrBody.length)}) — Node keeps original bytes, no storage rewrite`);
        }
        console.log(`    mem Δ cleanup : rss ${MB(memBefore)} → ${MB(rss())}`);
      } else {
        console.log(`    → owner=${owner}: cleanup SKIPPED (digital→pdf-lib / none)`);
      }
    } else {
      console.log(`    → cleanup disabled or no URL: SKIPPED`);
    }

    // ── STAGE 3: extract (resolveDrafts → render + OCR) ──
    const figurePrefix = `tenants/${upload.tenantId}/ocr-figures/DIAG-${upload.id}`;
    const pageStamps: number[] = [];
    const tExtractStart = now();
    console.log(`\n[3] extract       : starting render + OCR (OCR_PARALLEL_PAGES=${process.env.OCR_PARALLEL_PAGES ?? '1'})`);
    const memBeforeExtract = rss();
    const outcome = await resolveDrafts(ocrBody, mime, upload.storageKey, {
      settings: readHandwritingSettings(),
      figureKeyPrefix: figurePrefix,
      putObject: async (key, body, ct) => {
        putKeys.push(key);
        await client.send(
          new (await import('@aws-sdk/client-s3')).PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: ct }),
        );
      },
      onPageComplete: (processed, total) => {
        const t = now() - tExtractStart;
        const prev = pageStamps.length ? pageStamps[pageStamps.length - 1] : 0;
        pageStamps.push(t);
        console.log(`    page ${String(processed).padStart(2)}/${total} done @ +${t} ms   (Δ ${t - prev} ms)`);
      },
    });
    const tExtract = now() - tExtractStart;
    const draftCount = outcome.kind === 'route' ? outcome.nodeResult.drafts.length : outcome.result.drafts.length;
    const provider = outcome.kind === 'route' ? outcome.nodeResult.providerUsed : outcome.result.providerUsed;
    console.log(`    extract TOTAL : ${tExtract} ms   drafts=${draftCount}   provider=${provider}   kind=${outcome.kind}`);
    console.log(`    mem Δ extract : rss ${MB(memBeforeExtract)} → ${MB(rss())}`);

    // ── SUMMARY ──
    console.log('\n' + '═'.repeat(72));
    console.log('STAGE BREAKDOWN (processing only — excludes inline-queue wait)');
    console.log('═'.repeat(72));
    console.log(`storage_read   : ${tStorage} ms`);
    console.log(`extract(render+OCR): ${tExtract} ms`);
    console.log(`peak RSS       : ${MB(peakRss)}`);
    console.log('(cleanup timing printed in stage [2] above)');
  } finally {
    clearInterval(sampler);
    // Clean up throwaway DIAG figure crops.
    if (putKeys.length) {
      console.log(`\nCleaning up ${putKeys.length} DIAG figure crop(s)…`);
      for (const k of putKeys) {
        await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: k })).catch(() => undefined);
      }
    }
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
