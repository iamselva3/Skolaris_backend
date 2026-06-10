import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { UploadModel, UploadStatus } from '../../uploads/models/upload.model';
import { IUploadRepository, UPLOAD_REPOSITORY } from '../../uploads/repositories/upload.repository';
import { IOcrBatchRepository, OCR_BATCH_REPOSITORY } from '../repositories/ocr-batch.repository';

/** Coarse per-file state derived from the upload's own status. */
export type BatchFileState = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface BatchFileProgress {
  uploadId: string;
  batchOrder: number;
  /** 1-based position for display ("File 2 of 5"). */
  position: number;
  originalName: string;
  state: BatchFileState;
  draftCount: number;
  errorMessage: string | null;
}

export interface OcrBatchProgressSnapshot {
  batchId: string;
  total: number;
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  /**
   * The file currently being OCR'd (concurrency is 1), or — if none is mid-OCR
   * — the next queued file. Null once every file is terminal. Drives the
   * "Processing: File 2 of 5" line.
   */
  current: { uploadId: string; batchOrder: number; position: number; originalName: string } | null;
  files: BatchFileProgress[];
}

/**
 * Aggregate progress for a multi-file OCR batch. Reads each upload's own status
 * (the unchanged single-file pipeline writes these) and rolls them up — it does
 * not track anything the OCR pipeline doesn't already record.
 */
@Injectable()
export class GetOcrBatchProgressUseCase {
  constructor(
    @Inject(OCR_BATCH_REPOSITORY) private readonly batches: IOcrBatchRepository,
    @Inject(UPLOAD_REPOSITORY) private readonly uploads: IUploadRepository,
  ) {}

  async execute(input: { tenantId: string; batchId: string }): Promise<OcrBatchProgressSnapshot> {
    const batch = await this.batches.findById(input.tenantId, input.batchId);
    if (!batch) throw new NotFoundException('Batch not found');

    const uploads = await this.uploads.listByBatch(input.tenantId, input.batchId);

    const files: BatchFileProgress[] = uploads.map((u) => ({
      uploadId: u.id,
      batchOrder: u.batchOrder ?? 0,
      position: (u.batchOrder ?? 0) + 1,
      originalName: u.originalName,
      state: this.mapState(u.status),
      draftCount: u.draftCount ?? 0,
      errorMessage: u.errorMessage,
    }));

    const queued = files.filter((f) => f.state === 'QUEUED').length;
    const processing = files.filter((f) => f.state === 'PROCESSING').length;
    const completed = files.filter((f) => f.state === 'COMPLETED').length;
    const failed = files.filter((f) => f.state === 'FAILED').length;

    // "Current" = the in-flight file (there is at most one, concurrency 1), else
    // the next queued file so the UI can show what's up next.
    const current =
      files.find((f) => f.state === 'PROCESSING') ?? files.find((f) => f.state === 'QUEUED') ?? null;

    return {
      batchId: batch.id,
      total: batch.totalFiles,
      queued,
      processing,
      completed,
      failed,
      current: current
        ? {
            uploadId: current.uploadId,
            batchOrder: current.batchOrder,
            position: current.position,
            originalName: current.originalName,
          }
        : null,
      files,
    };
  }

  private mapState(status: UploadStatus): BatchFileState {
    switch (status) {
      case 'PENDING_UPLOAD':
      case 'UPLOADED':
        return 'QUEUED';
      case 'PROCESSING':
        return 'PROCESSING';
      case 'READY_FOR_REVIEW':
      case 'APPROVED':
        return 'COMPLETED';
      case 'FAILED':
        return 'FAILED';
      default:
        return 'QUEUED';
    }
  }
}
