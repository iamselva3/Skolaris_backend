import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { v4 as uuid } from 'uuid';
import { storageConfig } from '../../../shared/config/storage.config';
import { StageTimer } from '../../../shared/common/utils/stage-timer';
import {
  IObjectStorage,
  OBJECT_STORAGE,
  SignedUploadUrl,
} from '../../../shared/storage/object-storage.interface';
import { TaxonomyResolverService } from '../../taxonomy/services/taxonomy-resolver.service';
import { ALLOWED_UPLOAD_MIME_TYPES, normalizeMimeType, UploadModel } from '../models/upload.model';
import { IUploadRepository, UPLOAD_REPOSITORY } from '../repositories/upload.repository';

export interface CreateUploadInput {
  tenantId: string;
  uploadedBy: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number | null;
  programId?: string | null;
  subjectId?: string | null;
  /** Storage folder category (see UPLOAD_CATEGORIES). Defaults to 'uploads'. */
  category?: string | null;
}

/** Folders that may appear in a storage key. Guards path interpolation. */
const SAFE_CATEGORIES = new Set(['uploads', 'question-images', 'ocr-papers']);

export interface CreateUploadResult {
  upload: UploadModel;
  signedUpload: SignedUploadUrl;
}

@Injectable()
export class CreateUploadUseCase {
  private readonly logger = new Logger('OCR-PIPELINE/create-upload');

  constructor(
    @Inject(UPLOAD_REPOSITORY) private readonly uploads: IUploadRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: IObjectStorage,
    @Inject(storageConfig.KEY) private readonly cfg: ConfigType<typeof storageConfig>,
    private readonly taxonomy: TaxonomyResolverService,
  ) {}

  async execute(input: CreateUploadInput): Promise<CreateUploadResult> {
    const t = new StageTimer();
    const rawMime = input.mimeType;
    const mimeType = normalizeMimeType(rawMime);
    this.logger.log(
      `[1/4] requested name="${input.originalName}" mime="${rawMime}"${
        rawMime !== mimeType ? ` (normalized → ${mimeType})` : ''
      } size=${input.sizeBytes ?? '?'} bytes tenant=${input.tenantId}`,
    );

    if (!ALLOWED_UPLOAD_MIME_TYPES.has(mimeType)) {
      this.logger.warn(`[reject] unsupported mime "${rawMime}"`);
      throw new BadRequestException(`Unsupported mime type: ${rawMime}`);
    }
    input = { ...input, mimeType };
    if (input.sizeBytes !== null && input.sizeBytes > this.cfg.uploadMaxBytes) {
      this.logger.warn(`[reject] oversize ${input.sizeBytes} > ${this.cfg.uploadMaxBytes}`);
      throw new BadRequestException(`File too large (max ${this.cfg.uploadMaxBytes} bytes)`);
    }

    await this.taxonomy.resolve(input.tenantId, {
      programId: input.programId,
      subjectId: input.subjectId,
    });
    this.logger.log(`[2/4] taxonomy resolved ${t.mark()}`);

    // Structured path: tenants/<id>/<category>/<date>/<uuid>-<name>. Category
    // is whitelisted here (defence in depth on top of DTO validation) so it
    // can never inject `..` or extra path segments.
    const category =
      input.category && SAFE_CATEGORIES.has(input.category) ? input.category : 'uploads';
    const storageKey = `tenants/${input.tenantId}/${category}/${new Date().toISOString().slice(0, 10)}/${uuid()}-${input.originalName}`;

    const signedUpload = await this.storage.createSignedUploadUrl({
      storageKey,
      contentType: input.mimeType,
      ttlSeconds: this.cfg.uploadUrlTtlSeconds,
      maxBytes: this.cfg.uploadMaxBytes,
    });
    this.logger.log(
      `[3/4] signed httpMethod=${signedUpload.httpMethod} ${t.mark()} url="${signedUpload.signedUrl.slice(0, 80)}…"`,
    );

    const upload = await this.uploads.create({
      tenantId: input.tenantId,
      uploadedBy: input.uploadedBy,
      originalName: input.originalName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      storageKey,
      programId: input.programId ?? null,
      subjectId: input.subjectId ?? null,
    });
    this.logger.log(
      `[4/4] upload row created id=${upload.id} ${t.mark()} — handed back to client (${t.totalLabel()})`,
    );

    return { upload, signedUpload };
  }
}
