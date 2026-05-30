import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { OcrJobModel } from '../models/ocr-job.model';
import {
  IOcrJobRepository,
  OCR_JOB_REPOSITORY,
} from '../repositories/ocr-job.repository';

export interface GetOcrJobResult {
  job: OcrJobModel;
  draftCounts: Record<string, number>;
}

@Injectable()
export class GetOcrJobUseCase {
  constructor(@Inject(OCR_JOB_REPOSITORY) private readonly ocrJobs: IOcrJobRepository) {}

  async execute(input: { tenantId: string; id: string }): Promise<GetOcrJobResult> {
    const job = await this.ocrJobs.findById(input.tenantId, input.id);
    if (!job) throw new NotFoundException('OCR job not found');
    const draftCounts = await this.ocrJobs.countDraftsByStatus(input.tenantId, job.id);
    return { job, draftCounts };
  }
}
