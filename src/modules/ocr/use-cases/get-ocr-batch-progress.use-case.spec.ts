import { NotFoundException } from '@nestjs/common';
import { UploadModel, UploadStatus } from '../../uploads/models/upload.model';
import { IUploadRepository } from '../../uploads/repositories/upload.repository';
import { OcrBatchModel } from '../models/ocr-batch.model';
import { IOcrBatchRepository } from '../repositories/ocr-batch.repository';
import { GetOcrBatchProgressUseCase } from './get-ocr-batch-progress.use-case';

const bUpload = (
  id: string,
  status: UploadStatus,
  order: number,
  draftCount: number,
  errorMessage: string | null = null,
): UploadModel =>
  new UploadModel(
    id,
    't-1',
    'teacher-1',
    `${id}.pdf`,
    'application/pdf',
    null,
    `k/${id}`,
    status,
    errorMessage,
    null,
    null,
    new Date(),
    new Date(),
    draftCount,
    'b-1',
    order,
  );

describe('GetOcrBatchProgressUseCase', () => {
  let uploads: jest.Mocked<Pick<IUploadRepository, 'listByBatch'>>;
  let batches: jest.Mocked<IOcrBatchRepository>;
  let useCase: GetOcrBatchProgressUseCase;

  beforeEach(() => {
    uploads = { listByBatch: jest.fn() };
    batches = {
      create: jest.fn(),
      findById: jest.fn().mockResolvedValue(new OcrBatchModel('b-1', 't-1', 'teacher-1', 5, new Date(), new Date())),
      listByTenant: jest.fn(),
    };
    useCase = new GetOcrBatchProgressUseCase(batches, uploads as unknown as IUploadRepository);
  });

  it('404s an unknown batch', async () => {
    batches.findById.mockResolvedValue(null);
    await expect(useCase.execute({ tenantId: 't-1', batchId: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('aggregates queued/processing/completed/failed and points current at the in-flight file', async () => {
    uploads.listByBatch.mockResolvedValue([
      bUpload('a', 'READY_FOR_REVIEW', 0, 10),
      bUpload('b', 'PROCESSING', 1, 0),
      bUpload('c', 'PENDING_UPLOAD', 2, 0),
      bUpload('d', 'UPLOADED', 3, 0),
      bUpload('e', 'FAILED', 4, 0, 'boom'),
    ]);

    const snap = await useCase.execute({ tenantId: 't-1', batchId: 'b-1' });

    expect(snap.total).toBe(5);
    expect(snap.completed).toBe(1);
    expect(snap.processing).toBe(1);
    expect(snap.queued).toBe(2); // PENDING_UPLOAD + UPLOADED
    expect(snap.failed).toBe(1);
    // "Processing: File 2 of 5"
    expect(snap.current).toEqual({ uploadId: 'b', batchOrder: 1, position: 2, originalName: 'b.pdf' });
    expect(snap.files.find((f) => f.uploadId === 'e')?.errorMessage).toBe('boom');
  });

  it('falls back current to the next queued file when nothing is processing', async () => {
    uploads.listByBatch.mockResolvedValue([
      bUpload('a', 'READY_FOR_REVIEW', 0, 8),
      bUpload('b', 'PENDING_UPLOAD', 1, 0),
    ]);
    const snap = await useCase.execute({ tenantId: 't-1', batchId: 'b-1' });
    expect(snap.processing).toBe(0);
    expect(snap.current?.uploadId).toBe('b');
  });

  it('reports current=null once every file is terminal', async () => {
    uploads.listByBatch.mockResolvedValue([
      bUpload('a', 'READY_FOR_REVIEW', 0, 8),
      bUpload('b', 'FAILED', 1, 0, 'x'),
    ]);
    const snap = await useCase.execute({ tenantId: 't-1', batchId: 'b-1' });
    expect(snap.current).toBeNull();
  });
});
