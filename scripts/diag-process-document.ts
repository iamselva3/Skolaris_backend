/* eslint-disable no-console */
/**
 * READ-ONLY reproduction of the exact POST /process-document call the runner makes,
 * for a given (paused) OCR job. Prints HTTP status, timing, and the response head or
 * the error — so we see WHY processDocumentHttp returned null (timeout / non-200 /
 * Python exception). Does NOT write to our DB.
 *
 *   npx ts-node --transpile-only scripts/diag-process-document.ts <ocrJobId>
 */
import { PrismaClient } from '@prisma/client';
import { readStructureBuildSettings } from '../src/shared/ocr-engine/structure-analyze-http';

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config();
} catch {
  /* env assumed pre-populated */
}

async function main(): Promise<void> {
  const jobId = (process.argv[2] ?? '').trim();
  if (!jobId) {
    console.log('usage: diag-process-document.ts <ocrJobId>');
    return;
  }
  const prisma = new PrismaClient();
  try {
    const job = await prisma.ocrJob.findUnique({ where: { id: jobId } });
    if (!job) {
      console.log(`job ${jobId} not found`);
      return;
    }
    const upload = await prisma.upload.findUnique({ where: { id: job.uploadId } });
    const bset = readStructureBuildSettings();
    console.log('═'.repeat(72));
    console.log(`job        : ${jobId}`);
    console.log(`status     : ${job.status}`);
    console.log(`upload     : ${upload?.originalName}  [${job.uploadId}]`);
    console.log(`storageKey : ${upload?.storageKey}`);
    console.log(`serviceUrl : ${bset.serviceUrl}`);
    console.log(`timeoutMs  : ${bset.timeoutMs}`);
    console.log('═'.repeat(72));
    if (!upload?.storageKey || !bset.serviceUrl) {
      console.log('missing storageKey or serviceUrl — cannot call.');
      return;
    }

    const url = `${bset.serviceUrl.replace(/\/+$/, '')}/process-document`;
    const body = JSON.stringify({ storageKey: upload.storageKey, documentId: jobId });
    console.log(`POST ${url}`);
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), bset.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });
      const dt = Date.now() - t0;
      console.log(`→ HTTP ${res.status} ${res.statusText} in ${dt}ms`);
      const text = await res.text();
      if (!res.ok) {
        console.log('--- error body (head) ---');
        console.log(text.slice(0, 4000));
        return;
      }
      // success — summarize the count chain so we can see deliver/crops
      try {
        const j = JSON.parse(text);
        console.log('--- response summary ---');
        console.log(`questions      : ${j.questions?.length ?? 0}`);
        console.log(`build.cropCount: ${j.build?.cropCount ?? 0}`);
        console.log(`deliver        : ${j.deliver}`);
        console.log(`ocrDegradedPages: ${j.ocrDegradedPages}`);
        console.log(`routing[0]     : ${JSON.stringify(j.routing?.[0] ?? null)}`);
        console.log(`engineStatus   : ${JSON.stringify(j.engineStatus ?? null)}`);
      } catch {
        console.log('response (head):', text.slice(0, 2000));
      }
    } catch (err) {
      const dt = Date.now() - t0;
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.log(`→ FETCH FAILED in ${dt}ms — ${msg}`);
      console.log(`(this is exactly what makes processDocumentHttp return null → "engine unavailable" → PAUSE)`);
      if (/abort/i.test(msg)) console.log(`CAUSE: timed out after ${bset.timeoutMs}ms (STRUCTURE_BUILD_TIMEOUT_MS).`);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
