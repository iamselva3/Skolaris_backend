import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { IOcrDispatcher } from './ocr-dispatcher';
import { OcrExtractJob } from './ocr-queue.service';
import { OcrJobRunner, isOcrResumableEnabled } from '../workers/ocr-job-runner.service';
import { HandleOcrCallbackUseCase } from '../../modules/ocr/use-cases/handle-ocr-callback.use-case';
import { IOcrJobRepository, OCR_JOB_REPOSITORY } from '../../modules/ocr/repositories/ocr-job.repository';

/**
 * QUEUE_DRIVER=inline OCR backend: runs extraction IN-PROCESS, with NO Redis /
 * BullMQ. This is what removes Redis as a deployment dependency for OCR.
 *
 * Contract preservation:
 *   - enqueue() is FIRE-AND-FORGET — it schedules the job and returns
 *     immediately, so CompleteUploadUseCase still acks the upload as PROCESSING
 *     without blocking the HTTP request on OCR. The frontend's existing
 *     status-poll (PROCESSING → READY_FOR_REVIEW) is unchanged.
 *   - Jobs run on a single serial promise-chain (concurrency 1), mirroring the
 *     BullMQ worker's `{ concurrency: 1 }` so Tesseract is never run reentrantly.
 *
 * The OcrJobRunner is resolved LAZILY via ModuleRef (non-strict) on first use,
 * not constructor-injected, so this infra-level service carries no construct-time
 * dependency on OcrModule (which would form a QueueModule→OcrModule→UploadsModule
 * cycle). By first enqueue the whole DI graph is initialised.
 *
 * Trade-off vs. Redis: no cross-restart durability and no auto-retry. A job lost
 * to a process restart leaves the upload in PROCESSING until StuckUploadsCron
 * flips it to FAILED (UI offers Retry) — acceptable at current OCR volume.
 */
@Injectable()
export class InlineOcrDispatcher implements IOcrDispatcher {
  private readonly logger = new Logger(InlineOcrDispatcher.name);
  private runner: OcrJobRunner | null = null;
  private jobs: IOcrJobRepository | null = null;
  private callback: HandleOcrCallbackUseCase | null = null;
  /** Serial tail: each job awaits the previous one → concurrency 1 (P2: never raised). */
  private tail: Promise<void> = Promise.resolve();
  /** Jobs enqueued but not yet finished (running OR waiting). Drives queue position. */
  private pending = 0;

  constructor(private readonly moduleRef: ModuleRef) {}

  private getRunner(): OcrJobRunner {
    if (!this.runner) {
      this.runner = this.moduleRef.get<OcrJobRunner>(OcrJobRunner, { strict: false });
    }
    return this.runner;
  }

  // Lazy (ModuleRef, non-strict) like the runner — avoids a construct-time
  // QueueModule→OcrModule cycle; the DI graph is initialised by first enqueue.
  private getJobs(): IOcrJobRepository {
    if (!this.jobs) this.jobs = this.moduleRef.get<IOcrJobRepository>(OCR_JOB_REPOSITORY, { strict: false });
    return this.jobs;
  }

  private getCallback(): HandleOcrCallbackUseCase {
    if (!this.callback) {
      this.callback = this.moduleRef.get<HandleOcrCallbackUseCase>(HandleOcrCallbackUseCase, { strict: false });
    }
    return this.callback;
  }

  /** Hard ceiling for a single inline OCR job (P0). Past this the queue advances
   *  even if run() never settles. Default 8 min; tune with OCR_INLINE_JOB_TIMEOUT_MS. */
  private timeoutMs(): number {
    const v = Number(process.env.OCR_INLINE_JOB_TIMEOUT_MS);
    return Number.isFinite(v) && v > 0 ? v : 8 * 60 * 1000;
  }

  enqueue(job: OcrExtractJob): Promise<string> {
    const runner = this.getRunner();
    const position = this.pending; // jobs ahead of this one on the serial tail
    this.pending += 1;
    // P1 — surface REAL queue state. If anything is ahead, the job is genuinely
    // WAITING (not "Reading pages 5%"); publish QUEUED + position so the UI can
    // show "Queued · waiting for previous OCR job". When run() starts it overwrites
    // this with OCR_PROCESSING. Best-effort; a progress write must never break dispatch.
    if (position > 0) {
      this.getJobs()
        .updateProgress(job.ocrJobId, { stage: 'QUEUED', queuePosition: position })
        .catch(() => undefined);
    }
    // MEASUREMENT ONLY (Problem 1): stamp enqueue time so runGuarded can log how
    // long this job waited on the serial tail before run() actually started.
    const enqueuedAt = Date.now();
    // P0 — chain onto the serial tail through a TIMEOUT GUARD so a hung run() can
    // never leave `this.tail` pending forever and block all future uploads.
    this.tail = this.tail.then(() => this.runGuarded(job, runner, enqueuedAt));
    this.logger.log(
      `Inline OCR dispatch scheduled for upload ${job.uploadId} (ocrJob ${job.ocrJobId}) queuePosition=${position}`,
    );
    return Promise.resolve(job.ocrJobId);
  }

  /**
   * Run one job with a hard timeout (P0). The tail awaits THIS — which always
   * settles — so the queue advances on completion, failure, OR timeout. On timeout
   * the job is marked FAILED via the same callback the runner uses on error (upload
   * → FAILED, UI offers Retry); the orphaned run() may keep going harmlessly but no
   * longer gates the queue. Concurrency stays 1.
   */
  private async runGuarded(job: OcrExtractJob, runner: OcrJobRunner, enqueuedAt?: number): Promise<void> {
    // Queue wait = time from enqueue (right after upload complete) to the moment
    // this job reached the head of the serial tail and run() is about to start.
    // ≈0 ⇒ started immediately; large ⇒ blocked behind a previous job (concurrency 1).
    if (typeof enqueuedAt === 'number') {
      this.logger.log(
        `[ocr-timing] queue_wait upload=${job.uploadId} ocrJob=${job.ocrJobId} wait=${Date.now() - enqueuedAt}ms`,
      );
    }
    const ms = this.timeoutMs();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
    });
    const work = runner
      .run(job, { rethrow: false })
      .then(() => 'done' as const)
      .catch((err) => {
        this.logger.error(
          `Inline OCR job ${job.ocrJobId} (upload ${job.uploadId}) crashed unexpectedly: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return 'done' as const;
      });
    try {
      const outcome = await Promise.race([work, timeout]);
      if (outcome === 'timeout') {
        const reason = `OCR timed out after ${Math.round(ms / 1000)}s`;
        if (isOcrResumableEnabled()) {
          // Resumable OCR (P0): the timeout only stops THIS execution. Per-page
          // checkpoints are preserved and the upload stays PROCESSING — PAUSE the
          // job so the recovery service resumes it from the last completed page.
          this.logger.error(
            `Inline OCR job ${job.ocrJobId} (upload ${job.uploadId}) exceeded ${ms}ms — PAUSED (resumable) and ADVANCING the queue (orphaned run no longer blocks).`,
          );
          await this.getJobs().markPaused(job.ocrJobId, reason).catch(() => undefined);
        } else {
          this.logger.error(
            `Inline OCR job ${job.ocrJobId} (upload ${job.uploadId}) exceeded ${ms}ms — marking FAILED and ADVANCING the queue (run continues orphaned, no longer blocks).`,
          );
          await this.getCallback()
            .execute({
              ocrJobId: job.ocrJobId,
              providerUsed: 'tesseract',
              overallConfidence: 0,
              drafts: [],
              errorMessage: reason,
            })
            .catch(() => undefined);
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.pending = Math.max(0, this.pending - 1);
    }
  }
}
