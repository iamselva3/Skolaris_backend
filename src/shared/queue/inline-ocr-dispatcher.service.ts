import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { IOcrDispatcher } from './ocr-dispatcher';
import { OcrExtractJob } from './ocr-queue.service';
import { OcrJobRunner } from '../workers/ocr-job-runner.service';

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
  /** Serial tail: each job awaits the previous one → concurrency 1. */
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly moduleRef: ModuleRef) {}

  private getRunner(): OcrJobRunner {
    if (!this.runner) {
      this.runner = this.moduleRef.get<OcrJobRunner>(OcrJobRunner, { strict: false });
    }
    return this.runner;
  }

  enqueue(job: OcrExtractJob): Promise<string> {
    const runner = this.getRunner();
    // Chain onto the serial tail; never let one job's failure break the chain
    // (run() already marks the upload FAILED internally on error).
    this.tail = this.tail.then(() =>
      runner.run(job, { rethrow: false }).catch((err) => {
        this.logger.error(
          `Inline OCR job ${job.ocrJobId} (upload ${job.uploadId}) crashed unexpectedly: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }),
    );
    this.logger.log(
      `Inline OCR dispatch scheduled for upload ${job.uploadId} (ocrJob ${job.ocrJobId})`,
    );
    return Promise.resolve(job.ocrJobId);
  }
}
