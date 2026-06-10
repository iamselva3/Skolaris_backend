import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { IOcrJobRepository, OCR_JOB_REPOSITORY } from '../../ocr/repositories/ocr-job.repository';
import { OcrJobModel } from '../../ocr/models/ocr-job.model';
import { UploadModel } from '../models/upload.model';
import { IUploadRepository, UPLOAD_REPOSITORY } from '../repositories/upload.repository';

export interface GetUploadResult {
  upload: UploadModel;
  ocrJob: OcrJobModel | null;
  draftCounts: Record<string, number> | null;
}

@Injectable()
export class GetUploadUseCase {
  constructor(
    @Inject(UPLOAD_REPOSITORY) private readonly uploads: IUploadRepository,
    @Inject(OCR_JOB_REPOSITORY) private readonly ocrJobs: IOcrJobRepository,
  ) {}

  async execute(input: { tenantId: string; id: string }): Promise<GetUploadResult> {
    const upload = await this.uploads.findById(input.tenantId, input.id);
    if (!upload) throw new NotFoundException('Upload not found');
    const ocrJob = await this.ocrJobs.findByUploadId(input.tenantId, input.id);
    const draftCounts = ocrJob
      ? await this.ocrJobs.countDraftsByStatus(input.tenantId, ocrJob.id)
      : null;
    return { upload, ocrJob, draftCounts };
  }
}
