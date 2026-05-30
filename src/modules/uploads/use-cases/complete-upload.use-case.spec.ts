import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { IObjectStorage } from '../../../shared/storage/object-storage.interface';
import { OcrQueueService } from '../../../shared/queue/ocr-queue.service';
import { IOcrJobRepository } from '../../ocr/repositories/ocr-job.repository';
import { OcrJobModel } from '../../ocr/models/ocr-job.model';
import { UploadModel } from '../models/upload.model';
import { IUploadRepository } from '../repositories/upload.repository';
import { CompleteUploadUseCase } from './complete-upload.use-case';

const upload = (overrides: Partial<UploadModel> = {}): UploadModel =>
  new UploadModel(
    overrides.id ?? 'u-1',
    overrides.tenantId ?? 't-1',
    overrides.uploadedBy ?? 'teacher-1',
    overrides.originalName ?? 'paper.pdf',
    overrides.mimeType ?? 'application/pdf',
    overrides.sizeBytes ?? null,
    overrides.storageKey ?? 'tenants/t-1/uploads/x.pdf',
    overrides.status ?? 'PENDING_UPLOAD',
    overrides.errorMessage ?? null,
    overrides.programId ?? null,
    overrides.subjectId ?? null,
    new Date(),
    new Date(),
  );

const job = (id = 'job-1'): OcrJobModel =>
  new OcrJobModel(id, 't-1', 'u-1', new Date(), null, null, null, null, null, null, new Date(), new Date());

describe('CompleteUploadUseCase', () => {
  let uploads: jest.Mocked<IUploadRepository>;
  let ocrJobs: jest.Mocked<IOcrJobRepository>;
  let storage: jest.Mocked<IObjectStorage>;
  let queue: jest.Mocked<OcrQueueService>;
  let useCase: CompleteUploadUseCase;

  beforeEach(() => {
    uploads = {
      create: jest.fn(),
      findById: jest.fn(),
      list: jest.fn(),
      updateStatus: jest.fn().mockImplementation(async (_t, _id, status) => upload({ status })),
      failStuckProcessing: jest.fn(),
      remove: jest.fn(),
    };
    ocrJobs = {
      create: jest.fn().mockResolvedValue(job()),
      findById: jest.fn(),
      findByIdAnyTenant: jest.fn(),
      findByUploadId: jest.fn().mockResolvedValue(null),
      countDraftsByStatus: jest.fn(),
      markFinished: jest.fn(),
      markFailed: jest.fn(),
    };
    storage = {
      createSignedUploadUrl: jest.fn(),
      deleteObject: jest.fn(),
      objectExists: jest.fn().mockResolvedValue(true),
      getObject: jest.fn(),
    };
    queue = {
      enqueue: jest.fn().mockResolvedValue('job-1'),
    } as unknown as jest.Mocked<OcrQueueService>;

    useCase = new CompleteUploadUseCase(uploads, ocrJobs, storage, queue);
  });

  it('happy path: transitions to PROCESSING and enqueues OCR job', async () => {
    uploads.findById.mockResolvedValue(upload());
    const r = await useCase.execute({
      actor: { sub: 'teacher-1', tenantId: 't-1', branchId: null, role: Role.TEACHER },
      id: 'u-1',
    });
    expect(r.status).toBe('PROCESSING');
    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ ocrJobId: 'job-1', uploadId: 'u-1' }),
    );
  });

  it('throws 404 when upload missing', async () => {
    uploads.findById.mockResolvedValue(null);
    await expect(
      useCase.execute({
        actor: { sub: 't', tenantId: 't', branchId: null, role: Role.TEACHER },
        id: 'u-1',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('forbids TEACHER from completing someone else upload', async () => {
    uploads.findById.mockResolvedValue(upload({ uploadedBy: 'other-teacher' }));
    await expect(
      useCase.execute({
        actor: { sub: 'teacher-1', tenantId: 't-1', branchId: null, role: Role.TEACHER },
        id: 'u-1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects if upload is not PENDING_UPLOAD', async () => {
    uploads.findById.mockResolvedValue(upload({ status: 'UPLOADED' }));
    await expect(
      useCase.execute({
        actor: { sub: 'teacher-1', tenantId: 't-1', branchId: null, role: Role.TEACHER },
        id: 'u-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects if storage object missing', async () => {
    uploads.findById.mockResolvedValue(upload());
    storage.objectExists.mockResolvedValue(false);
    await expect(
      useCase.execute({
        actor: { sub: 'teacher-1', tenantId: 't-1', branchId: null, role: Role.TEACHER },
        id: 'u-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
