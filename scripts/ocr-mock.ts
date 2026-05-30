/*
 * Mock OCR worker. Stands in for the real Python OCR microservice during local
 * dev and CI so the upload → OCR → review → question-bank loop can be exercised
 * end-to-end without PaddleOCR.
 *
 * Consumes the `ocr.extract` BullMQ queue. For each job: pauses briefly (so the
 * UI can show PROCESSING state), then POSTs a canned 5-draft payload to the
 * backend callback endpoint with a valid HMAC-SHA256 signature.
 *
 * Env:
 *   REDIS_URL                bullmq connection
 *   OCR_QUEUE_NAME           default 'ocr.extract'
 *   OCR_CALLBACK_URL         full URL, e.g. http://localhost:3000/api/internal/ocr/callback
 *   OCR_CALLBACK_SECRET      shared secret (must match backend's OCR_CALLBACK_SECRET)
 *   OCR_MOCK_DELAY_MS        artificial latency before callback (default 3000)
 *
 * Run:
 *   ts-node scripts/ocr-mock.ts        # dev (uses tsconfig paths via ts-node)
 *   node dist/scripts/ocr-mock.js      # production (after `npm run build`)
 */

import { createHmac } from 'crypto';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import 'dotenv/config';

interface OcrExtractJob {
  ocrJobId: string;
  tenantId: string;
  uploadId: string;
  storageKey: string;
}

interface CallbackDraft {
  position: number;
  text: string;
  detectedType: string;
  options?: Array<{ label: string; isCorrect?: boolean }>;
  confidence: number;
}

interface CallbackPayload {
  ocrJobId: string;
  providerUsed: string;
  overallConfidence: number;
  drafts: CallbackDraft[];
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
// Default tuned for "feels operationally responsive" on a single-teacher dev
// box. Real PaddleOCR on a modest CPU will be 2-5x slower — override via env
// when load-testing or benchmarking against the real service.
const delayMs = Number(env('OCR_MOCK_DELAY_MS', '800'));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A representative cross-type spread so the FE has something to render. */
const buildDrafts = (): CallbackDraft[] => [
  {
    position: 0,
    text: 'A particle moves with x(t) = 3t² − 6t + 2. Find v at t = 4 s.',
    detectedType: 'SINGLE_CHOICE',
    options: [
      { label: '12 m/s' },
      { label: '18 m/s', isCorrect: true },
      { label: '24 m/s' },
      { label: '−18 m/s' },
    ],
    confidence: 0.92,
  },
  {
    position: 1,
    text: 'Which of the following are primes? Select all that apply.',
    detectedType: 'MULTIPLE_CHOICE',
    options: [
      { label: '2', isCorrect: true },
      { label: '3', isCorrect: true },
      { label: '4' },
      { label: '5', isCorrect: true },
    ],
    confidence: 0.88,
  },
  {
    position: 2,
    text: 'The Earth orbits the Sun. (True / False)',
    detectedType: 'TRUE_FALSE',
    confidence: 0.95,
  },
  {
    position: 3,
    text: 'The capital of France is ____.',
    detectedType: 'FILL_BLANK',
    confidence: 0.9,
  },
  {
    position: 4,
    text: 'Explain Newton’s second law in 2–3 sentences.',
    detectedType: 'DESCRIPTIVE',
    confidence: 0.82,
  },
];

const postCallback = async (payload: CallbackPayload): Promise<void> => {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', callbackSecret).update(body).digest('hex');
  const res = await fetch(callbackUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ocr-signature': signature,
    },
    body,
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Callback ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
};

const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

const worker = new Worker<OcrExtractJob>(
  queueName,
  async (job) => {
    const { ocrJobId, uploadId } = job.data;
    const t0 = Date.now();
    // eslint-disable-next-line no-console
    console.log(`[ocr-mock] job=${job.id} ocrJob=${ocrJobId} upload=${uploadId} accepted`);

    await sleep(delayMs);
    const tAfterExtract = Date.now();

    const payload: CallbackPayload = {
      ocrJobId,
      providerUsed: 'mock',
      overallConfidence: 0.89,
      drafts: buildDrafts(),
    };
    await postCallback(payload);
    const tAfterCallback = Date.now();
    // eslint-disable-next-line no-console
    console.log(
      `[ocr-mock] job=${job.id} delivered ${payload.drafts.length} drafts | extract=${tAfterExtract - t0}ms callback=${tAfterCallback - tAfterExtract}ms total=${tAfterCallback - t0}ms`,
    );
  },
  { connection },
);

worker.on('ready', () => {
  // eslint-disable-next-line no-console
  console.log(
    `[ocr-mock] listening queue="${queueName}" callback="${callbackUrl}" delay=${delayMs}ms`,
  );
});

worker.on('failed', (job, err) => {
  // eslint-disable-next-line no-console
  console.error(`[ocr-mock] job ${job?.id} FAILED: ${err.message}`);
});

const shutdown = async (signal: string): Promise<void> => {
  // eslint-disable-next-line no-console
  console.log(`[ocr-mock] caught ${signal}, draining...`);
  try {
    await worker.close();
    await connection.quit();
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
