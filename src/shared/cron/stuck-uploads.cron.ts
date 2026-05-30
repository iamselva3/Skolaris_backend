import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  IUploadRepository,
  UPLOAD_REPOSITORY,
} from '../../modules/uploads/repositories/upload.repository';

/**
 * Recovers uploads stuck in PROCESSING for longer than the cutoff (default 5 min)
 * — happens when the OCR worker dies between dequeue and callback. Marks them
 * FAILED with an actionable error message so the UI can offer "Retry".
 *
 * Runs every minute. Idempotent: only flips rows whose updated_at < cutoff.
 */
@Injectable()
export class StuckUploadsCron {
  private readonly logger = new Logger(StuckUploadsCron.name);
  // Default 5 min, unchanged. Configurable so the slower Python handwriting
  // fallback (PaddleOCR/TrOCR on answer sheets) is not prematurely FAILED.
  private readonly cutoffMs = Number(process.env.OCR_STUCK_CUTOFF_MS) || 5 * 60 * 1000;

  constructor(
    @Inject(UPLOAD_REPOSITORY) private readonly uploads: IUploadRepository,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    const cutoff = new Date(Date.now() - this.cutoffMs);
    const minutes = Math.round(this.cutoffMs / 60_000);
    const failed = await this.uploads.failStuckProcessing(
      cutoff,
      `OCR worker did not respond within ${minutes} minute(s). Verify the worker is running (\`npm run ocr:mock\` or \`docker compose up ocr-mock\`) and retry the upload.`,
    );
    if (failed > 0) {
      this.logger.warn(
        `Marked ${failed} stuck PROCESSING upload(s) as FAILED (cutoff ${cutoff.toISOString()})`,
      );
    }
  }
}
