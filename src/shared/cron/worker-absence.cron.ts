import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OcrHandwritingQueueService } from '../queue/ocr-handwriting-queue.service';
import { OcrQueueService } from '../queue/ocr-queue.service';

/**
 * Operator visibility: when OCR jobs pile up in the `ocr.extract` wait queue
 * with NO worker connected (or no active job movement), log a loud actionable
 * warning. Catches the most common dev-env failure mode: API + frontend
 * running, but the operator forgot to start `npm run ocr:mock`.
 *
 * Without this cron, jobs sit silently for 5 minutes before the stuck-upload
 * cron flips them to FAILED with "no worker callback within 5 minutes" — by
 * then the teacher has been staring at "Extracting…" with no clue why.
 *
 * Runs every 30 seconds. Cheap (3 BullMQ calls + a log line).
 */
@Injectable()
export class WorkerAbsenceCron {
  private readonly logger = new Logger('OCR-PIPELINE/worker-absence');
  private warnedAt: number | null = null;
  private hwWarnedAt: number | null = null;
  /** Don't repeat the warning more often than every 2 minutes. */
  private readonly REPEAT_INTERVAL_MS = 2 * 60 * 1000;

  constructor(
    private readonly queue: OcrQueueService,
    private readonly handwritingQueue: OcrHandwritingQueueService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async run(): Promise<void> {
    await this.checkHandwritingQueue();

    const [waiting, active, workers] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getConnectedWorkerCount(),
    ]);

    if (waiting === 0 && active === 0) {
      // Healthy idle — reset so the next backup re-warns.
      this.warnedAt = null;
      return;
    }

    if (workers === 0 && waiting > 0) {
      const now = Date.now();
      if (this.warnedAt && now - this.warnedAt < this.REPEAT_INTERVAL_MS) return;
      this.warnedAt = now;
      this.logger.warn(
        `╔══════════════════════════════════════════════════════════════════╗
║  No OCR worker is connected to the queue.                        ║
║  ${waiting} job(s) waiting; nothing is consuming them.${' '.repeat(Math.max(0, 14 - String(waiting).length))}║
║                                                                  ║
║  Start the worker in a separate terminal:                        ║
║    npm run ocr:mock         (dev — mock drafts)                  ║
║  Or via docker compose:                                          ║
║    docker compose up ocr-mock                                    ║
║                                                                  ║
║  Without a worker, uploads sit for 5 min then flip to FAILED.    ║
╚══════════════════════════════════════════════════════════════════╝`,
      );
      return;
    }

    if (workers === 0 && active > 0) {
      // Shouldn't happen — active jobs without workers means an orphan.
      this.logger.warn(
        `${active} active OCR job(s) but no connected worker — likely a worker that died mid-job. ` +
          `These will retry per BullMQ backoff; if they don't, restart the worker.`,
      );
    }
  }

  /**
   * Additive watch for the optional handwriting queue. Inert unless
   * HANDWRITING_OCR_ENABLED=true (so it never touches the lazy queue / opens a
   * Redis connection in the default deployment). Warns when routed jobs pile up
   * with no Python consumer connected.
   */
  private async checkHandwritingQueue(): Promise<void> {
    if (process.env.HANDWRITING_OCR_ENABLED !== 'true') return;
    const [waiting, workers] = await Promise.all([
      this.handwritingQueue.getWaitingCount(),
      this.handwritingQueue.getConnectedWorkerCount(),
    ]);
    if (waiting > 0 && workers === 0) {
      const now = Date.now();
      if (this.hwWarnedAt && now - this.hwWarnedAt < this.REPEAT_INTERVAL_MS) return;
      this.hwWarnedAt = now;
      this.logger.warn(
        `Handwriting OCR is enabled but NO consumer is connected to "ocr.handwriting" — ${waiting} job(s) waiting. ` +
          'Start it: `docker compose --profile handwriting up ocr-handwriting`.',
      );
    } else if (waiting === 0) {
      this.hwWarnedAt = null;
    }
  }
}
