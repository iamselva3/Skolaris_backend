import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  IOcrJobRepository,
  OCR_JOB_REPOSITORY,
  ResumableOcrJob,
} from '../../modules/ocr/repositories/ocr-job.repository';
import { OCR_DISPATCHER, IOcrDispatcher } from '../queue/ocr-dispatcher';
import { isOcrResumableEnabled } from '../workers/ocr-job-runner.service';

/**
 * Resumable OCR (P0) — auto-recovery. Guarantees no OCR job is ever abandoned:
 *
 *   1. onApplicationBootstrap (covers backend stop/restart, crash, hot reload,
 *      deployment, env change): EVERY non-terminal job is orphaned by definition
 *      after a process restart, so all of them are re-dispatched. Pages already
 *      checkpointed are skipped by the engine, so a job resumes from where it
 *      stopped — never page 1.
 *
 *   2. @Cron every minute (covers unexpected OCR exceptions, timeouts, worker
 *      stopped WITHOUT a process restart): resume PAUSED jobs immediately and
 *      PROCESSING/RESUMING jobs that have gone silent (Upload.updatedAt stale).
 *
 * Jobs that exhaust OCR_MAX_RESUME_ATTEMPTS are terminally FAILED (failExhausted)
 * so a genuinely-broken job still settles instead of looping forever.
 *
 * Inert when OCR_RESUMABLE=0 — the legacy StuckUploadsCron then owns liveness.
 */
@Injectable()
export class OcrRecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OcrRecoveryService.name);

  // Cap auto-resume attempts. High by default because each attempt makes forward
  // progress (more pages checkpointed); the cap only guards a page that always throws.
  private readonly maxAttempts = Number(process.env.OCR_MAX_RESUME_ATTEMPTS) || 25;
  // A PROCESSING/RESUMING job whose Upload.updatedAt is older than this is treated
  // as hung and resumed. Mirrors the StuckUploadsCron cutoff (default 5 min).
  private readonly staleCutoffMs = Number(process.env.OCR_STUCK_CUTOFF_MS) || 5 * 60 * 1000;

  constructor(
    @Inject(OCR_JOB_REPOSITORY) private readonly ocrJobs: IOcrJobRepository,
    @Inject(OCR_DISPATCHER) private readonly dispatcher: IOcrDispatcher,
  ) {}

  /** On boot, any in-flight job is orphaned — resume all of them from checkpoint. */
  async onApplicationBootstrap(): Promise<void> {
    if (!isOcrResumableEnabled()) return;
    try {
      await this.ocrJobs.failExhausted(this.maxAttempts, this.exhaustedReason());
      const jobs = await this.ocrJobs.findResumable({
        maxAttempts: this.maxAttempts,
        staleBefore: new Date(),
        includeFresh: true,
      });
      if (jobs.length > 0) {
        this.logger.warn(`Startup recovery: resuming ${jobs.length} in-flight OCR job(s) from checkpoint`);
        for (const job of jobs) await this.resume(job);
      }
    } catch (err) {
      this.logger.error(
        `Startup OCR recovery failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Every minute, resume PAUSED jobs and any that went silent mid-run. */
  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<void> {
    if (!isOcrResumableEnabled()) return;
    try {
      const failed = await this.ocrJobs.failExhausted(this.maxAttempts, this.exhaustedReason());
      if (failed > 0) {
        this.logger.warn(`OCR recovery: FAILED ${failed} job(s) that exhausted ${this.maxAttempts} attempt(s)`);
      }
      const jobs = await this.ocrJobs.findResumable({
        maxAttempts: this.maxAttempts,
        staleBefore: new Date(Date.now() - this.staleCutoffMs),
        includeFresh: false,
      });
      for (const job of jobs) await this.resume(job);
      if (jobs.length > 0) {
        this.logger.log(`OCR recovery: re-dispatched ${jobs.length} resumable job(s)`);
      }
    } catch (err) {
      this.logger.error(
        `OCR recovery sweep failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Flip to RESUMING and re-dispatch through the SAME backend a fresh upload uses. */
  private async resume(job: ResumableOcrJob): Promise<void> {
    try {
      await this.ocrJobs.markResuming(job.id);
      await this.dispatcher.enqueue({
        ocrJobId: job.id,
        tenantId: job.tenantId,
        uploadId: job.uploadId,
        storageKey: job.storageKey,
      });
      this.logger.log(
        `Resumed OCR job ${job.id} (upload ${job.uploadId}) from page ${job.lastCompletedPage + 1} — attempt ${job.attemptCount + 1}`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to re-dispatch OCR job ${job.id} (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private exhaustedReason(): string {
    return `OCR did not complete after ${this.maxAttempts} resume attempt(s). Please retry the upload.`;
  }
}
