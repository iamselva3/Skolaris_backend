import { Decimal } from '@prisma/client/runtime/library';
import { OcrJobModel } from '../models/ocr-job.model';

export const OCR_JOB_REPOSITORY = Symbol('OCR_JOB_REPOSITORY');

export interface CreateOcrJobInput {
  tenantId: string;
  uploadId: string;
}

export interface IOcrJobRepository {
  create(input: CreateOcrJobInput): Promise<OcrJobModel>;
  findById(tenantId: string, id: string): Promise<OcrJobModel | null>;
  findByIdAnyTenant(id: string): Promise<OcrJobModel | null>;
  findByUploadId(tenantId: string, uploadId: string): Promise<OcrJobModel | null>;
  countDraftsByStatus(tenantId: string, ocrJobId: string): Promise<Record<string, number>>;
  markFinished(input: {
    id: string;
    overallConfidence: Decimal | null;
    rawOutput: unknown;
    providerUsed: string | null;
  }): Promise<OcrJobModel>;
  markFailed(input: { id: string; errorMessage: string }): Promise<OcrJobModel>;
}
