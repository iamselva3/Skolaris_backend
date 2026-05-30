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

export interface QueueConfig {
  redisUrl: string;
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

export const queueConfig = registerAs<QueueConfig>('queue', () => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('Missing required env var: REDIS_URL');
  }
  return {
    redisUrl,
    ocrQueueName: process.env.OCR_QUEUE_NAME ?? 'ocr.extract',
    handwritingQueueName: process.env.HW_OCR_QUEUE_NAME ?? 'ocr.handwriting',
    analyticsQueueName: process.env.ANALYTICS_QUEUE_NAME ?? 'analytics.aggregate',
    notificationsQueueName: process.env.NOTIFICATIONS_QUEUE_NAME ?? 'notifications.dispatch',
    workerMode: parseWorkerMode(process.env.WORKER_MODE),
  };
});
