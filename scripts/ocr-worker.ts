/*
 * Real OCR worker (STANDALONE process). Same queue/HMAC contract as
 * scripts/ocr-mock.ts, but fetches the uploaded file from storage and runs
 * Tesseract.js / pdf-to-img against it.
 *
 * The actual extraction logic (storage fetch, Tesseract, PDF rasterization,
 * draft parsing) now lives in the shared, framework-agnostic engine at
 * src/shared/ocr-engine/ocr-engine.ts so this standalone worker and the
 * in-process NestJS consumer (src/shared/workers/ocr.processor.ts) run the
 * EXACT same code. This script keeps only the standalone concerns: BullMQ
 * Worker wiring, the HMAC-signed HTTP callback, and process signal handling.
 *
 * Pipeline:
 *   1. Dequeue OcrExtractJob from BullMQ ocr.extract
 *   2. engine.fetchObjectBytes(storageKey) → bytes + mime
 *   3. engine.extractDrafts(bytes, mime)   → drafts (image or per-page PDF OCR)
 *   4. POST drafts back to the API callback with a valid HMAC signature
 *
 * Env (loaded from .env via dotenv):
 *   REDIS_URL                 BullMQ broker
 *   OCR_QUEUE_NAME            default 'ocr.extract'
 *   OCR_CALLBACK_URL          API callback endpoint
 *   OCR_CALLBACK_SECRET       HMAC secret (must match backend)
 *   STORAGE_READ_BASE_URL     backend read-proxy base, e.g. https://<api-host>/api (read by the engine)
 *
 * Run:
 *   npm run ocr:real          (after `npm install`)
 *   npm run dev:full          (concurrently runs API + this worker)
 */

import 'dotenv/config';
import { createHmac } from 'crypto';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import {
  fetchObjectBytes,
  resetTesseract,
  shutdownTesseract,
  type OcrEngineDraft,
} from '../src/shared/ocr-engine/ocr-engine';
import { readHandwritingSettings, resolveDrafts } from '../src/shared/ocr-engine/resolve-drafts';
import { dispatchHandwritingHttp } from '../src/shared/ocr-engine/handwriting-http';

interface OcrExtractJob {
  ocrJobId: string;
  tenantId: string;
  uploadId: string;
  storageKey: string;
}

interface CallbackPayload {
  ocrJobId: string;
  providerUsed: string;
  overallConfidence: number;
  drafts: OcrEngineDraft[];
  errorMessage?: string;
}

const env = (key: string, fallback?: string): string => {
  const v = process.env[key];
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${key}`);
};

const redisUrl = env('REDIS_URL');
const queueName = env('OCR_QUEUE_NAME', 'ocr.extract');
const callbackUrl = env('OCR_CALLBACK_URL', 'http://localhost:3000/api/internal/ocr/callback');
const callbackSecret = env('OCR_CALLBACK_SECRET');
// Object bytes are fetched by the shared engine's fetchObjectBytes(), which
// resolves the read host from STORAGE_READ_BASE_URL (the backend read-proxy).
const hwQueueName = env('HW_OCR_QUEUE_NAME', 'ocr.handwriting');

/* ─── Secondary handwriting queue (lazy: no connection unless the fallback routes) */
let hwQueue: Queue<OcrExtractJob> | null = null;
let hwConnection: Redis | null = null;
const getHwQueue = (): Queue<OcrExtractJob> => {
  if (!hwQueue) {
    hwConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    hwQueue = new Queue<OcrExtractJob>(hwQueueName, { connection: hwConnection });
  }
  return hwQueue;
};

/* ─────────────────────────────────────────── Callback (HMAC over HTTP) */

const postCallback = async (payload: CallbackPayload): Promise<void> => {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', callbackSecret).update(body).digest('hex');
  const res = await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ocr-signature': signature },
    body,
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Callback ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
};

/* ─────────────────────────────────────────── Worker entrypoint */

const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

const worker = new Worker<OcrExtractJob>(
  queueName,
  async (job) => {
    const { ocrJobId, uploadId, storageKey } = job.data;
    const t0 = Date.now();
    // eslint-disable-next-line no-console
    console.log(`[ocr-worker] job=${job.id} ocrJob=${ocrJobId} upload=${uploadId} accepted`);

    try {
      const { bytes, mime } = await fetchObjectBytes(storageKey);
      const settings = readHandwritingSettings();
      const outcome = await resolveDrafts(bytes, mime, storageKey, { settings });

      // Handwriting fallback (flag ON + classifier routes).
      if (outcome.kind === 'route') {
        if (settings.dispatch === 'http') {
          // Inline-HTTP: call the Python service; on failure degrade to Node.
          const py = await dispatchHandwritingHttp(
            { ocrJobId, storageKey, mime },
            { serviceUrl: settings.serviceUrl, timeoutMs: settings.timeoutMs },
          );
          const r = py ?? outcome.nodeResult;
          await postCallback({
            ocrJobId,
            providerUsed: r.providerUsed,
            overallConfidence: r.overallConfidence,
            drafts: r.drafts,
          });
          // eslint-disable-next-line no-console
          console.log(
            `[ocr-worker] job=${job.id} handwriting ${py ? 'via HTTP' : 'HTTP unavailable → degraded to Node'} | ${r.drafts.length} draft(s)`,
          );
          return;
        }
        // Queue mode (default): hand off + SUPPRESS this callback so exactly ONE
        // component writes the terminal result. Inert when flag off.
        await getHwQueue().add('extract', job.data, { jobId: ocrJobId });
        // eslint-disable-next-line no-console
        console.log(
          `[ocr-worker] job=${job.id} routed to handwriting queue "${hwQueueName}" (${outcome.decision.reason}); callback suppressed`,
        );
        return;
      }

      const { providerUsed, overallConfidence, drafts } = outcome.result;
      await postCallback({ ocrJobId, providerUsed, overallConfidence, drafts });
      // eslint-disable-next-line no-console
      console.log(
        `[ocr-worker] job=${job.id} delivered ${drafts.length} draft(s) | total=${Date.now() - t0}ms provider=${providerUsed}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[ocr-worker] job=${job.id} FAILED: ${message}`);
      // Tell the backend so the upload flips to FAILED with a useful error.
      await postCallback({
        ocrJobId,
        providerUsed: 'tesseract',
        overallConfidence: 0,
        drafts: [],
        errorMessage: message.slice(0, 500),
      }).catch(() => {
        /* if callback itself fails, BullMQ retries the job */
      });
      throw err;
    }
  },
  { connection, concurrency: 1 },
);

worker.on('ready', () => {
  // eslint-disable-next-line no-console
  console.log(
    `[ocr-worker] listening queue="${queueName}" callback="${callbackUrl}" readBase="${process.env.STORAGE_READ_BASE_URL ?? '(unset!)'}"`,
  );
});

worker.on('failed', (job, err) => {
  // eslint-disable-next-line no-console
  console.error(`[ocr-worker] job ${job?.id} ultimately failed: ${err.message}`);
});

const shutdown = async (signal: string): Promise<void> => {
  // eslint-disable-next-line no-console
  console.log(`[ocr-worker] caught ${signal}, draining…`);
  try {
    await worker.close();
    if (hwQueue) await hwQueue.close();
    if (hwConnection) await hwConnection.quit();
    await shutdownTesseract();
    await connection.quit();
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

/**
 * Resilience net. A malformed/odd image can make tesseract.js throw from its
 * internal worker thread, escaping the per-job try/catch as an uncaught
 * exception. Left unhandled the process would exit — and under
 * `concurrently --kill-others-on-fail` (npm run dev:full) that would take the
 * API down with it. Instead: log loudly, drop the (possibly poisoned)
 * Tesseract singleton so the next job re-initialises a clean one, and keep the
 * worker alive to drain the rest of the queue.
 */
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error(`[ocr-worker] uncaughtException (worker kept alive): ${err?.message ?? err}`);
  resetTesseract();
});
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error(
    `[ocr-worker] unhandledRejection (worker kept alive): ${
      reason instanceof Error ? reason.message : String(reason)
    }`,
  );
  resetTesseract();
});
