import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { CompleteUploadUseCase } from '../../uploads/use-cases/complete-upload.use-case';
import { IUploadRepository, UPLOAD_REPOSITORY } from '../../uploads/repositories/upload.repository';
import { IOcrBatchRepository, OCR_BATCH_REPOSITORY } from '../repositories/ocr-batch.repository';

export interface CreateOcrBatchResultFile {
  uploadId: string;
  batchOrder: number;
  /** true when the file was handed to the (unchanged) OCR dispatcher. */
  dispatched: boolean;
  /** Present when dispatch failed for this file (the queue still continued). */
  error?: string;
}

export interface CreateOcrBatchResult {
  batchId: string;
  totalFiles: number;
  files: CreateOcrBatchResultFile[];
}

/**
 * Multi-file OCR import — pure orchestration layer. It groups already-uploaded
 * files into an OcrBatch and feeds them to the EXISTING single-file pipeline one
 * at a time, in order, by reusing CompleteUploadUseCase verbatim. It changes
 * nothing about OCR extraction, segmentation, or draft generation.
 *
 * Sequencing: CompleteUploadUseCase dispatches fire-and-forget onto the OCR
 * backend, which already runs at concurrency 1 (inline serial tail / BullMQ
 * worker concurrency 1). Enqueuing in batchOrder therefore yields strictly
 * sequential OCR — A → B → C → D — with no change to the dispatcher.
 *
 * Failure isolation: a per-file dispatch error is caught, the upload is marked
 * FAILED, and the loop continues so one bad file never stops the queue. (OCR
 * runtime failures are already isolated downstream by the runner + serial tail.)
 */
@Injectable()
export class CreateOcrBatchUseCase {
  private readonly logger = new Logger('OCR-PIPELINE/create-batch');

  constructor(
    @Inject(OCR_BATCH_REPOSITORY) private readonly batches: IOcrBatchRepository,
    @Inject(UPLOAD_REPOSITORY) private readonly uploads: IUploadRepository,
    private readonly completeUpload: CompleteUploadUseCase,
  ) {}

  async execute(input: {
    actor: AuthenticatedUser;
    uploadIds: string[];
  }): Promise<CreateOcrBatchResult> {
    const { actor, uploadIds } = input;

    if (!uploadIds || uploadIds.length === 0) {
      throw new BadRequestException('A batch must contain at least one upload');
    }
    if (new Set(uploadIds).size !== uploadIds.length) {
      throw new BadRequestException('A batch cannot contain the same upload twice');
    }

    const fetchedUploads = [];
    // Pre-validate every file BEFORE any side effect, so an invalid id rejects
    // the whole request cleanly (nothing created/tagged yet). These mirror the
    // checks CompleteUploadUseCase enforces per file.
    for (const id of uploadIds) {
      const upload = await this.uploads.findById(actor.tenantId, id);
      if (!upload) throw new NotFoundException(`Upload ${id} not found`);
      if (actor.role === Role.TEACHER && upload.uploadedBy !== actor.sub) {
        throw new ForbiddenException(`Teachers can only batch their own uploads (${id})`);
      }
      if (upload.status !== 'PENDING_UPLOAD') {
        throw new ConflictException(
          `Upload ${id} is in status ${upload.status}; only PENDING_UPLOAD uploads can be batched`,
        );
      }
      fetchedUploads.push(upload);
    }

    // Chronological sort: force the parts into oldest-first order (the natural
    // timeline they were created) regardless of UI selection/array order.
    fetchedUploads.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const batch = await this.batches.create({
      tenantId: actor.tenantId,
      createdBy: actor.sub,
      totalFiles: uploadIds.length,
    });
    this.logger.log(`batch ${batch.id} created with ${uploadIds.length} file(s)`);

    const files: CreateOcrBatchResultFile[] = [];
    for (let order = 0; order < fetchedUploads.length; order++) {
      const uploadId = fetchedUploads[order].id;
      // Tag first so the file shows in the batch even if its dispatch fails.
      await this.uploads.assignBatch(actor.tenantId, uploadId, batch.id, order);
      try {
        await this.completeUpload.execute({ actor, id: uploadId });
        files.push({ uploadId, batchOrder: order, dispatched: true });
        this.logger.log(`batch ${batch.id} [${order + 1}/${uploadIds.length}] dispatched ${uploadId}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Failure isolation: mark this file FAILED and keep feeding the queue.
        await this.uploads
          .updateStatus(actor.tenantId, uploadId, 'FAILED', message)
          .catch(() => undefined);
        files.push({ uploadId, batchOrder: order, dispatched: false, error: message });
        this.logger.warn(
          `batch ${batch.id} [${order + 1}/${uploadIds.length}] failed to dispatch ${uploadId}: ${message} — continuing`,
        );
      }
    }

    return { batchId: batch.id, totalFiles: uploadIds.length, files };
  }
}
