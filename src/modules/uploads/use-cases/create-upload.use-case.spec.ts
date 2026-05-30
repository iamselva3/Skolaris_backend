import { BadRequestException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { storageConfig } from '../../../shared/config/storage.config';
import { IObjectStorage } from '../../../shared/storage/object-storage.interface';
import { TaxonomyResolverService } from '../../taxonomy/services/taxonomy-resolver.service';
import { UploadModel } from '../models/upload.model';
import { IUploadRepository } from '../repositories/upload.repository';
import { CreateUploadUseCase } from './create-upload.use-case';

const cfg = {
  provider: 'gcs',
  uploadMaxBytes: 25 * 1024 * 1024,
  uploadUrlTtlSeconds: 900,
  gcs: { bucket: 'b', apiEndpoint: null, projectId: null, publicHost: null, serviceAccountJsonPath: null },
  s3: { bucket: '', region: '', accessKeyId: null, secretAccessKey: null, endpoint: null, publicEndpoint: null, forcePathStyle: true },
} satisfies ConfigType<typeof storageConfig>;

describe('CreateUploadUseCase', () => {
  let uploads: jest.Mocked<IUploadRepository>;
  let storage: jest.Mocked<IObjectStorage>;
  let useCase: CreateUploadUseCase;

  beforeEach(() => {
    uploads = {
      create: jest.fn().mockImplementation(async (i) =>
        new UploadModel(
          'u-1',
          i.tenantId,
          i.uploadedBy,
          i.originalName,
          i.mimeType,
          i.sizeBytes !== null ? BigInt(i.sizeBytes) : null,
          i.storageKey,
          'PENDING_UPLOAD',
          null,
          null,
          null,
          new Date(),
          new Date(),
        ),
      ),
      findById: jest.fn(),
      list: jest.fn(),
      updateStatus: jest.fn(),
      failStuckProcessing: jest.fn(),
      remove: jest.fn(),
    };
    storage = {
      createSignedUploadUrl: jest.fn().mockResolvedValue({
        signedUrl: 'http://fake/upload?x=1',
        storageKey: 'placeholder',
        expiresAt: new Date(Date.now() + 60_000),
      }),
      deleteObject: jest.fn(),
      objectExists: jest.fn(),
      getObject: jest.fn(),
    };
    const taxonomy = {
      resolve: jest.fn().mockResolvedValue({ program: null, subject: null, topic: null, chapter: null }),
    } as unknown as TaxonomyResolverService;
    useCase = new CreateUploadUseCase(uploads, storage, cfg, taxonomy);
  });

  it('creates an upload row and signed URL for a PDF', async () => {
    const r = await useCase.execute({
      tenantId: 't-1',
      uploadedBy: 'teacher-1',
      originalName: 'paper.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1234,
    });
    expect(r.upload.storageKey).toMatch(/^tenants\/t-1\/uploads\//);
    expect(r.signedUpload.signedUrl).toContain('fake');
    expect(uploads.create).toHaveBeenCalled();
  });

  it('rejects an unsupported mime type', async () => {
    await expect(
      useCase.execute({
        tenantId: 't-1',
        uploadedBy: 'teacher-1',
        originalName: 'paper.exe',
        mimeType: 'application/x-msdownload',
        sizeBytes: 1234,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when sizeBytes exceeds limit', async () => {
    await expect(
      useCase.execute({
        tenantId: 't-1',
        uploadedBy: 'teacher-1',
        originalName: 'huge.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 999_999_999,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
