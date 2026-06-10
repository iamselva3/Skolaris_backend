import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../../shared/database/prisma.service';
import { StageTimer } from '../../../shared/common/utils/stage-timer';
import { CreateNotificationUseCase } from '../../notifications/use-cases/create-notification.use-case';
import { IUploadRepository, UPLOAD_REPOSITORY } from '../../uploads/repositories/upload.repository';
import { OcrCallbackDto } from '../dtos/ocr-callback.dto';
import { OcrJobModel } from '../models/ocr-job.model';
import { IOcrDraftRepository, OCR_DRAFT_REPOSITORY } from '../repositories/ocr-draft.repository';
import { IOcrJobRepository, OCR_JOB_REPOSITORY } from '../repositories/ocr-job.repository';

export interface HandleOcrCallbackResult {
  ocrJob: OcrJobModel;
  draftsWritten: number;
  alreadyProcessed: boolean;
}

@Injectable()
export class HandleOcrCallbackUseCase {
  private readonly logger = new Logger('OCR-PIPELINE/callback');

  constructor(
    @Inject(OCR_JOB_REPOSITORY) private readonly ocrJobs: IOcrJobRepository,
    @Inject(OCR_DRAFT_REPOSITORY) private readonly ocrDrafts: IOcrDraftRepository,
    @Inject(UPLOAD_REPOSITORY) private readonly uploads: IUploadRepository,
    private readonly notifications: CreateNotificationUseCase,
    private readonly prisma: PrismaService,
  ) {}

  async execute(dto: OcrCallbackDto): Promise<HandleOcrCallbackResult> {
    const t = new StageTimer();
    this.logger.log(
      `[1/4] received callback job=${dto.ocrJobId} provider=${dto.providerUsed ?? '?'} drafts=${dto.drafts.length} error=${dto.errorMessage ?? 'none'}`,
    );

    const job = await this.ocrJobs.findByIdAnyTenant(dto.ocrJobId);
    if (!job) {
      this.logger.error(`[FAIL] unknown ocrJobId=${dto.ocrJobId}`);
      throw new NotFoundException(`OCR job ${dto.ocrJobId} not found`);
    }

    if (dto.errorMessage) {
      this.logger.error(`[FAIL] worker reported error for job ${job.id}: ${dto.errorMessage}`);
      // Phase 2 — flip progress stage to FAILED before the FE polls again.
      await this.ocrJobs.updateProgress(job.id, { stage: 'FAILED' }).catch(() => undefined);
      const updated = await this.ocrJobs.markFailed({
        id: job.id,
        errorMessage: dto.errorMessage,
      });
      await this.uploads.updateStatus(job.tenantId, job.uploadId, 'FAILED', dto.errorMessage);
      const upload = await this.uploads.findById(job.tenantId, job.uploadId);
      if (upload) {
        await this.notifications.execute({
          tenantId: job.tenantId,
          recipientUserId: upload.uploadedBy,
          subject: 'OCR processing failed',
          body: `We could not process "${upload.originalName}": ${dto.errorMessage}`,
        });
      }
      return { ocrJob: updated, draftsWritten: 0, alreadyProcessed: false };
    }

    // Idempotency: skip if the job already produced drafts OR was already
    // finalized (finishedAt set). The finishedAt guard also protects the
    // handwriting fallback — once a terminal callback wins, a late/duplicate
    // callback for the same ocrJob is a benign no-op. (A cross-process row lock
    // is deferred to Phase 2, when the Python service becomes a second poster;
    // the single-writer routing rule already guarantees only one poster today.)
    const existingCount = await this.ocrDrafts.countByJob(job.tenantId, job.id);
    if (existingCount > 0 || job.finishedAt) {
      this.logger.warn(
        `[idempotent] job ${job.id} already finalized (drafts=${existingCount}, finishedAt=${job.finishedAt?.toISOString() ?? 'null'}); skipping`,
      );
      return { ocrJob: job, draftsWritten: 0, alreadyProcessed: true };
    }

    this.logger.log(`[2/4] writing ${dto.drafts.length} draft(s) for job ${job.id} ${t.mark()}`);
    // Phase 2 — flip progress stage to GENERATING_DRAFTS so the FE sees
    // "Generating Drafts" instead of "OCR Processing" during the (usually
    // short) callback transaction.
    await this.ocrJobs
      .updateProgress(job.id, { stage: 'GENERATING_DRAFTS' })
      .catch(() => undefined);

    const draftsWritten = await this.prisma.$transaction(async () => {
      const written = await this.ocrDrafts.bulkCreate(
        dto.drafts.map((d) => ({
          tenantId: job.tenantId,
          ocrJobId: job.id,
          position: d.position,
          text: d.text,
          detectedType: d.detectedType ?? null,
          options: d.options
            ? d.options.map((o) => ({ label: o.label, isCorrect: o.isCorrect ?? false }))
            : null,
          confidence: d.confidence ?? null,
          sourcePageNumber: d.sourcePageNumber ?? null,
          spanPageStart: d.spanPageStart ?? null,
          spanPageEnd: d.spanPageEnd ?? null,
          solutionText: d.solutionText ?? null,
          questionSnapshotKey: d.questionSnapshotKey ?? null,
          optionCount: d.optionCount ?? null,
          questionNumber: d.questionNumber ?? null,
          invalidCrop: d.invalidCrop ?? null,
          sourceCoordinates: d.sourceCoordinates ?? null,
          // Slice 2.3 — figure crops detected on the same page, associated to
          // this draft. The repo inserts OcrDraftFigure rows after the draft
          // ids are known.
          figures: d.figures?.map((f, idx) => ({
            figureIndex: idx,
            storageKey: f.storageKey,
            boundingBox: f.boundingBox,
            kind: f.kind,
            caption: f.caption ?? null,
          })),
        })),
      );

      await this.ocrJobs.markFinished({
        id: job.id,
        overallConfidence:
          dto.overallConfidence !== undefined ? new Decimal(dto.overallConfidence) : null,
        rawOutput: dto,
        providerUsed: dto.providerUsed ?? null,
        pageMetadata: dto.pageMetadata ?? null,
      });

      // Pass null to explicitly clear any stale errorMessage left by the
      // stuck-upload cron when the worker eventually catches up to a job that
      // was marked FAILED at the 5-min timeout. Without this, the row shows
      // READY_FOR_REVIEW but still carries "OCR processing timed out…" text.
      await this.uploads.updateStatus(job.tenantId, job.uploadId, 'READY_FOR_REVIEW', null);
      return written;
    });
    // Phase 2 — terminal happy stage. The FE's progress poll will see
    // COMPLETED and stop polling + invalidate the drafts query.
    await this.ocrJobs.updateProgress(job.id, { stage: 'COMPLETED' }).catch(() => undefined);
    this.logger.log(
      `[3/4] upload ${job.uploadId} → READY_FOR_REVIEW (${draftsWritten} drafts, errorMessage cleared) ${t.mark()}`,
    );

    const upload = await this.uploads.findById(job.tenantId, job.uploadId);
    if (upload) {
      await this.notifications.execute({
        tenantId: job.tenantId,
        recipientUserId: upload.uploadedBy,
        subject: 'Your upload is ready for review',
        body: `"${upload.originalName}" extracted ${draftsWritten} draft question(s). Open the review screen to approve.`,
      });
    }
    this.logger.log(
      `[4/4] notification dispatched to user ${upload?.uploadedBy ?? '?'} ${t.mark()} — callback handled in ${t.totalLabel()}`,
    );

    const refreshed = (await this.ocrJobs.findById(job.tenantId, job.id)) ?? job;
    return { ocrJob: refreshed, draftsWritten, alreadyProcessed: false };
  }
}
