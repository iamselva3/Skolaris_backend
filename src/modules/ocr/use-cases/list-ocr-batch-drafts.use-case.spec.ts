import { NotFoundException } from '@nestjs/common';
import { UploadModel } from '../../uploads/models/upload.model';
import { IUploadRepository } from '../../uploads/repositories/upload.repository';
import { OcrBatchModel } from '../models/ocr-batch.model';
import { OcrDraftModel } from '../models/ocr-draft.model';
import { OcrJobModel } from '../models/ocr-job.model';
import { IOcrBatchRepository } from '../repositories/ocr-batch.repository';
import { IOcrDraftRepository } from '../repositories/ocr-draft.repository';
import { IOcrJobRepository } from '../repositories/ocr-job.repository';
import { ListOcrBatchDraftsUseCase } from './list-ocr-batch-drafts.use-case';

const bUpload = (id: string, order: number): UploadModel =>
  new UploadModel(id, 't-1', 'teacher-1', `${id}.pdf`, 'application/pdf', null, `k/${id}`, 'READY_FOR_REVIEW', null, null, null, new Date(), new Date(), null, 'b-1', order);

const job = (id: string, uploadId: string): OcrJobModel =>
  new OcrJobModel(id, 't-1', uploadId, new Date(), null, null, null, null, null, null, new Date(), new Date());

const draft = (ocrJobId: string, position: number, qnum: number): OcrDraftModel => {
  const d = new OcrDraftModel(`${ocrJobId}-d${position}`, 't-1', ocrJobId, position, `q${qnum}`, null, null, null, 'PENDING_REVIEW', null, new Date(), new Date());
  d.questionNumber = qnum;
  return d;
};

describe('ListOcrBatchDraftsUseCase', () => {
  let batches: jest.Mocked<IOcrBatchRepository>;
  let uploads: jest.Mocked<Pick<IUploadRepository, 'listByBatch'>>;
  let ocrJobs: jest.Mocked<Pick<IOcrJobRepository, 'findByUploadId'>>;
  let drafts: jest.Mocked<Pick<IOcrDraftRepository, 'countByJob' | 'list'>>;
  let useCase: ListOcrBatchDraftsUseCase;

  beforeEach(() => {
    batches = {
      create: jest.fn(),
      findById: jest.fn().mockResolvedValue(new OcrBatchModel('b-1', 't-1', 'teacher-1', 2, new Date(), new Date())),
      listByTenant: jest.fn(),
    };
    uploads = { listByBatch: jest.fn() };
    ocrJobs = { findByUploadId: jest.fn() };
    drafts = { countByJob: jest.fn(), list: jest.fn() };
    useCase = new ListOcrBatchDraftsUseCase(
      batches,
      uploads as unknown as IUploadRepository,
      ocrJobs as unknown as IOcrJobRepository,
      drafts as unknown as IOcrDraftRepository,
    );
  });

  it('404s an unknown batch', async () => {
    batches.findById.mockResolvedValue(null);
    await expect(useCase.execute({ tenantId: 't-1', batchId: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('numbers drafts continuously across files while preserving each file\'s original question numbers', async () => {
    // PDF A: questions 1,2,3 — PDF B: questions 1,2 (numbering restarts in the source)
    uploads.listByBatch.mockResolvedValue([bUpload('a', 0), bUpload('b', 1)]);
    ocrJobs.findByUploadId.mockImplementation(async (_t, uploadId) =>
      uploadId === 'a' ? job('job-a', 'a') : job('job-b', 'b'),
    );
    drafts.countByJob.mockImplementation(async (_t, jobId) => (jobId === 'job-a' ? 3 : 2));
    drafts.list.mockImplementation(async (_t, jobId) =>
      jobId === 'job-a'
        ? { data: [draft('job-a', 0, 1), draft('job-a', 1, 2), draft('job-a', 2, 3)], total: 3 }
        : { data: [draft('job-b', 0, 1), draft('job-b', 1, 2)], total: 2 },
    );

    const res = await useCase.execute({ tenantId: 't-1', batchId: 'b-1' });

    expect(res.totalDrafts).toBe(5);
    expect(res.rows.map((r) => r.batchSequence)).toEqual([1, 2, 3, 4, 5]);
    // original OCR-detected numbers are untouched (A:1,2,3 then B:1,2)
    expect(res.rows.map((r) => r.draft.questionNumber)).toEqual([1, 2, 3, 1, 2]);
    // provenance: first three from file A, last two from file B
    expect(res.rows.map((r) => r.sourceFileName)).toEqual(['a.pdf', 'a.pdf', 'a.pdf', 'b.pdf', 'b.pdf']);
    expect(res.rows.map((r) => r.fileOrder)).toEqual([0, 0, 0, 1, 1]);
  });

  it('skips files with no OCR job or zero drafts (deterministic, stable for reprocessing)', async () => {
    uploads.listByBatch.mockResolvedValue([bUpload('a', 0), bUpload('b', 1), bUpload('c', 2)]);
    ocrJobs.findByUploadId.mockImplementation(async (_t, uploadId) => {
      if (uploadId === 'a') return job('job-a', 'a');
      if (uploadId === 'b') return null; // failed before OCR — no job
      return job('job-c', 'c');
    });
    drafts.countByJob.mockImplementation(async (_t, jobId) => (jobId === 'job-c' ? 0 : 2));
    drafts.list.mockResolvedValue({ data: [draft('job-a', 0, 1), draft('job-a', 1, 2)], total: 2 });

    const res = await useCase.execute({ tenantId: 't-1', batchId: 'b-1' });

    expect(res.totalDrafts).toBe(2);
    expect(res.rows.map((r) => r.batchSequence)).toEqual([1, 2]);
    expect(drafts.list).toHaveBeenCalledTimes(1); // only job-a produced drafts
  });
});
