import { UploadModel, UploadStatus } from '../models/upload.model';

export const UPLOAD_REPOSITORY = Symbol('UPLOAD_REPOSITORY');

export interface CreateUploadInput {
  tenantId: string;
  uploadedBy: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number | null;
  storageKey: string;
  programId?: string | null;
  subjectId?: string | null;
}

export interface IUploadRepository {
  create(input: CreateUploadInput): Promise<UploadModel>;
  findById(tenantId: string, id: string): Promise<UploadModel | null>;
  list(
    tenantId: string,
    filters: { status?: UploadStatus; uploadedBy?: string; limit: number; offset: number },
  ): Promise<{ data: UploadModel[]; total: number }>;
  updateStatus(
    tenantId: string,
    id: string,
    status: UploadStatus,
    errorMessage?: string | null,
  ): Promise<UploadModel>;
  /**
   * Flip every PROCESSING upload older than `cutoff` to FAILED with the given
   * error message. Returns the number of rows updated. Used by the stuck-upload
   * cron to recover when an OCR worker dies mid-job.
   */
  failStuckProcessing(cutoff: Date, errorMessage: string): Promise<number>;
  remove(tenantId: string, id: string): Promise<UploadModel>;
}
