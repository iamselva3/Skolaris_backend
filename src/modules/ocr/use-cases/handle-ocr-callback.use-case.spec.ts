import { NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { OcrJobModel } from '../models/ocr-job.model';
import { IOcrDraftRepository } from '../repositories/ocr-draft.repository';
import { IOcrJobRepository } from '../repositories/ocr-job.repository';
import { IUploadRepository } from '../../uploads/repositories/upload.repository';
import { UploadModel } from '../../uploads/models/upload.model';
import { CreateNotificationUseCase } from '../../notifications/use-cases/create-notification.use-case';
import { OcrCallbackDto } from '../dtos/ocr-callback.dto';
import { HandleOcrCallbackUseCase } from './handle-ocr-callback.use-case';

// Minimal Prisma stub: $transaction(cb) just runs cb with a fake tx (we don't use it).
const fakePrisma = {
  $transaction: async (cb: (tx: unknown) => Promise<number>) => cb({}),
} as unknown as import('../../../shared/database/prisma.service').PrismaService;

const makeJob = (overrides: Partial<OcrJobModel> = {}): OcrJobModel =>
  new OcrJobModel(
    overrides.id ?? 'job-1',
    overrides.tenantId ?? 'tenant-1',
    overrides.uploadId ?? 'upload-1',
    overrides.queuedAt ?? new Date(),
    overrides.startedAt ?? null,
    overrides.finishedAt ?? null,
    overrides.overallConfidence ?? null,
    overrides.errorMessage ?? null,
    overrides.rawOutput ?? null,
    overrides.providerUsed ?? null,
    overrides.createdAt ?? new Date(),
    overrides.updatedAt ?? new Date(),
  );

describe('HandleOcrCallbackUseCase', () => {
  let ocrJobs: jest.Mocked<IOcrJobRepository>;
  let drafts: jest.Mocked<IOcrDraftRepository>;
  let uploads: jest.Mocked<IUploadRepository>;
  let notifications: jest.Mocked<CreateNotificationUseCase>;
  let useCase: HandleOcrCallbackUseCase;

  beforeEach(() => {
    ocrJobs = {
      create: jest.fn(),
      findById: jest.fn(),
      findByIdAnyTenant: jest.fn(),
      findByUploadId: jest.fn(),
      countDraftsByStatus: jest.fn().mockResolvedValue({ PENDING_REVIEW: 3 }),
      markFinished: jest.fn().mockImplementation(async ({ id }) => makeJob({ id })),
      markFailed: jest.fn().mockImplementation(async ({ id }) => makeJob({ id })),
    };
    drafts = {
      bulkCreate: jest.fn().mockResolvedValue(3),
      list: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      countByJob: jest.fn().mockResolvedValue(0),
    };
    uploads = {
      create: jest.fn(),
      findById: jest.fn().mockResolvedValue(
        new UploadModel(
          'upload-1',
          'tenant-1',
          'teacher-1',
          'paper.pdf',
          'application/pdf',
          BigInt(1234),
          'tenants/tenant-1/uploads/x.pdf',
          'PROCESSING',
          null,
          null,
          null,
          new Date(),
          new Date(),
        ),
      ),
      list: jest.fn(),
      updateStatus: jest.fn().mockImplementation(async (_, __, ___) => null as never),
      failStuckProcessing: jest.fn(),
      remove: jest.fn(),
    };
    notifications = {
      execute: jest.fn().mockResolvedValue({} as never),
    } as unknown as jest.Mocked<CreateNotificationUseCase>;

    useCase = new HandleOcrCallbackUseCase(
      ocrJobs,
      drafts,
      uploads,
      notifications,
      fakePrisma,
    );
  });

  it('writes drafts, marks ready_for_review, and notifies on success', async () => {
    ocrJobs.findByIdAnyTenant.mockResolvedValue(makeJob());
    ocrJobs.findById.mockResolvedValue(makeJob({ overallConfidence: new Decimal('0.910') }));

    const dto: OcrCallbackDto = {
      ocrJobId: 'job-1',
      overallConfidence: 0.91,
      providerUsed: 'paddle',
      drafts: [
        { position: 0, text: 'Q1' },
        { position: 1, text: 'Q2' },
        { position: 2, text: 'Q3' },
      ],
    };
    const result = await useCase.execute(dto);

    expect(drafts.bulkCreate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ position: 0, text: 'Q1', ocrJobId: 'job-1' }),
      ]),
    );
    // 4th arg null intentionally clears any stale errorMessage left by the stuck-uploads cron.
    expect(uploads.updateStatus).toHaveBeenCalledWith('tenant-1', 'upload-1', 'READY_FOR_REVIEW', null);
    expect(notifications.execute).toHaveBeenCalled();
    expect(result.draftsWritten).toBe(3);
    expect(result.alreadyProcessed).toBe(false);
  });

  it('is idempotent — replaying does not re-write drafts', async () => {
    ocrJobs.findByIdAnyTenant.mockResolvedValue(makeJob());
    drafts.countByJob.mockResolvedValue(3); // already populated

    const result = await useCase.execute({ ocrJobId: 'job-1', drafts: [{ position: 0, text: 'x' }] });

    expect(drafts.bulkCreate).not.toHaveBeenCalled();
    expect(uploads.updateStatus).not.toHaveBeenCalled();
    expect(result.alreadyProcessed).toBe(true);
  });

  it('handles failure payload by marking upload FAILED', async () => {
    ocrJobs.findByIdAnyTenant.mockResolvedValue(makeJob());
    const result = await useCase.execute({
      ocrJobId: 'job-1',
      drafts: [],
      errorMessage: 'OCR engine crashed',
    });
    expect(ocrJobs.markFailed).toHaveBeenCalledWith({
      id: 'job-1',
      errorMessage: 'OCR engine crashed',
    });
    expect(uploads.updateStatus).toHaveBeenCalledWith(
      'tenant-1',
      'upload-1',
      'FAILED',
      'OCR engine crashed',
    );
    expect(notifications.execute).toHaveBeenCalled();
    expect(result.draftsWritten).toBe(0);
  });

  it('throws 404 when ocr job is unknown', async () => {
    ocrJobs.findByIdAnyTenant.mockResolvedValue(null);
    await expect(
      useCase.execute({ ocrJobId: 'missing', drafts: [] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
