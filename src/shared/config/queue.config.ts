import { registerAs } from '@nestjs/config';

/**
 * Deployment topology for the OCR consumer:
 *   'api'    → API only; OCR is consumed by an EXTERNAL worker (npm run ocr:real
 *              / a separate worker container). This is the DEFAULT and preserves
 *              today's behaviour exactly.
 *   'both'   → single service: API + an in-process OCR consumer in one process.
 *   'worker' → OCR consumer only (no HTTP listener) — same image, scaled apart.
 */
export type WorkerMode = 'api' | 'worker' | 'both';

/**
 * OCR dispatch backend:
 *   'inline' (default) → OCR runs in-process via InlineOcrDispatcher; NO Redis /
 *                        BullMQ is touched for OCR. Removes Redis as a deployment
 *                        dependency for the OCR pipeline.
 *   'redis'            → OCR is enqueued to BullMQ (OcrQueueService) and drained by
 *                        a worker (in-process OcrProcessor or external). The
 *                        original Phase-2 behaviour; requires REDIS_URL.
 *
 * NOTE: analytics + notifications still use BullMQ regardless of this flag
 * (Stage 2). They are the only remaining eager Redis consumers.
 */
export type QueueDriver = 'inline' | 'redis';

export interface QueueConfig {
  redisUrl: string;
  queueDriver: QueueDriver;
  ocrQueueName: string;
  /** Secondary queue for the optional Python handwriting fallback. */
  handwritingQueueName: string;
  analyticsQueueName: string;
  notificationsQueueName: string;
  workerMode: WorkerMode;
}

const parseWorkerMode = (raw: string | undefined): WorkerMode => {
  const v = (raw ?? 'api').toLowerCase();
  return v === 'worker' || v === 'both' ? v : 'api';
};

const parseQueueDriver = (raw: string | undefined): QueueDriver => {
  // Default to 'inline' so a fresh deploy needs no Redis for OCR.
  const v = (raw ?? 'inline').toLowerCase();
  return v === 'redis' ? 'redis' : 'inline';
};

export const queueConfig = registerAs<QueueConfig>('queue', () => {
  const queueDriver = parseQueueDriver(process.env.QUEUE_DRIVER);
  const redisUrl = process.env.REDIS_URL;
  // REDIS_URL is only mandatory when OCR is actually routed through Redis.
  // (analytics/notifications fall back to a localhost URL until Stage 2 — they
  // never block boot.)
  if (queueDriver === 'redis' && !redisUrl) {
    throw new Error('Missing required env var: REDIS_URL (required when QUEUE_DRIVER=redis)');
  }
  return {
    redisUrl: redisUrl ?? 'redis://localhost:6379',
    queueDriver,
    ocrQueueName: process.env.OCR_QUEUE_NAME ?? 'ocr.extract',
    handwritingQueueName: process.env.HW_OCR_QUEUE_NAME ?? 'ocr.handwriting',
    analyticsQueueName: process.env.ANALYTICS_QUEUE_NAME ?? 'analytics.aggregate',
    notificationsQueueName: process.env.NOTIFICATIONS_QUEUE_NAME ?? 'notifications.dispatch',
    workerMode: parseWorkerMode(process.env.WORKER_MODE),
  };
});
