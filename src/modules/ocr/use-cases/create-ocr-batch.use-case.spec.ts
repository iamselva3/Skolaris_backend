import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { UploadModel, UploadStatus } from '../../uploads/models/upload.model';
import { IUploadRepository } from '../../uploads/repositories/upload.repository';
import { CompleteUploadUseCase } from '../../uploads/use-cases/complete-upload.use-case';
import { OcrBatchModel } from '../models/ocr-batch.model';
import { IOcrBatchRepository } from '../repositories/ocr-batch.repository';
import { CreateOcrBatchUseCase } from './create-ocr-batch.use-case';

const actor: AuthenticatedUser = { sub: 'teacher-1', tenantId: 't-1', branchId: null, role: Role.TEACHER };

const upload = (id: string, status: UploadStatus = 'PENDING_UPLOAD', uploadedBy = 'teacher-1'): UploadModel =>
  new UploadModel(id, 't-1', uploadedBy, `${id}.pdf`, 'application/pdf', null, `k/${id}`, status, null, null, null, new Date(), new Date());

const fullUploadMock = (): jest.Mocked<IUploadRepository> => ({
  create: jest.fn(),
  findById: jest.fn(),
  list: jest.fn(),
  updateStatus: jest.fn().mockResolvedValue(undefined),
  failStuckProcessing: jest.fn(),
  remove: jest.fn(),
  assignBatch: jest.fn(),
  listByBatch: jest.fn(),
});

describe('CreateOcrBatchUseCase', () => {
  let uploads: jest.Mocked<IUploadRepository>;
  let batches: jest.Mocked<IOcrBatchRepository>;
  let completeUpload: jest.Mocked<CompleteUploadUseCase>;
  let useCase: CreateOcrBatchUseCase;

  beforeEach(() => {
    uploads = fullUploadMock();
    batches = {
      create: jest
        .fn()
        .mockResolvedValue(new OcrBatchModel('b-1', 't-1', 'teacher-1', 3, new Date(), new Date())),
      findById: jest.fn(),
      listByTenant: jest.fn(),
    };
    completeUpload = { execute: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<CompleteUploadUseCase>;
    useCase = new CreateOcrBatchUseCase(batches, uploads, completeUpload);
  });

  it('rejects an empty batch', async () => {
    await expect(useCase.execute({ actor, uploadIds: [] })).rejects.toBeInstanceOf(BadRequestException);
    expect(batches.create).not.toHaveBeenCalled();
  });

  it('rejects duplicate uploads in one batch', async () => {
    await expect(useCase.execute({ actor, uploadIds: ['a', 'a'] })).rejects.toBeInstanceOf(BadRequestException);
    expect(batches.create).not.toHaveBeenCalled();
  });

  it('rejects (and creates nothing) when an upload is missing', async () => {
    uploads.findById.mockResolvedValue(null);
    await expect(useCase.execute({ actor, uploadIds: ['a'] })).rejects.toBeInstanceOf(NotFoundException);
    expect(batches.create).not.toHaveBeenCalled();
    expect(uploads.assignBatch).not.toHaveBeenCalled();
  });

  it("forbids batching another teacher's upload", async () => {
    uploads.findById.mockResolvedValue(upload('a', 'PENDING_UPLOAD', 'other-teacher'));
    await expect(useCase.execute({ actor, uploadIds: ['a'] })).rejects.toBeInstanceOf(ForbiddenException);
    expect(batches.create).not.toHaveBeenCalled();
  });

  it('rejects an upload that is not PENDING_UPLOAD', async () => {
    uploads.findById.mockResolvedValue(upload('a', 'PROCESSING'));
    await expect(useCase.execute({ actor, uploadIds: ['a'] })).rejects.toBeInstanceOf(ConflictException);
    expect(batches.create).not.toHaveBeenCalled();
  });

  it('tags uploads in order and dispatches each through CompleteUploadUseCase sequentially', async () => {
    uploads.findById.mockImplementation(async (_t, id) => upload(id));
    const result = await useCase.execute({ actor, uploadIds: ['a', 'b', 'c'] });

    // batch created with the right count
    expect(batches.create).toHaveBeenCalledWith({ tenantId: 't-1', createdBy: 'teacher-1', totalFiles: 3 });

    // order preserved: assignBatch order args 0,1,2
    expect(uploads.assignBatch.mock.calls.map((c) => [c[1], c[3]])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);

    // each file handed to the UNCHANGED single-file complete/dispatch path, in order
    expect(completeUpload.execute.mock.calls.map((c) => c[0].id)).toEqual(['a', 'b', 'c']);
    expect(result.files.every((f) => f.dispatched)).toBe(true);
    expect(result.batchId).toBe('b-1');
  });

  it('isolates a failed file: marks it FAILED and keeps dispatching the rest', async () => {
    uploads.findById.mockImplementation(async (_t, id) => upload(id));
    completeUpload.execute.mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'b') throw new Error('storage missing');
      return undefined as never;
    });

    const result = await useCase.execute({ actor, uploadIds: ['a', 'b', 'c'] });

    // the queue did not stop — all three were attempted
    expect(completeUpload.execute.mock.calls.map((c) => c[0].id)).toEqual(['a', 'b', 'c']);
    // the bad file was flipped to FAILED
    expect(uploads.updateStatus).toHaveBeenCalledWith('t-1', 'b', 'FAILED', 'storage missing');
    expect(result.files).toEqual([
      { uploadId: 'a', batchOrder: 0, dispatched: true },
      { uploadId: 'b', batchOrder: 1, dispatched: false, error: 'storage missing' },
      { uploadId: 'c', batchOrder: 2, dispatched: true },
    ]);
  });
});
