import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { StageTimer } from '../../../shared/common/utils/stage-timer';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { IObjectStorage, OBJECT_STORAGE } from '../../../shared/storage/object-storage.interface';
import { OCR_DISPATCHER, IOcrDispatcher } from '../../../shared/queue/ocr-dispatcher';
import { IOcrJobRepository, OCR_JOB_REPOSITORY } from '../../ocr/repositories/ocr-job.repository';
import { UploadModel } from '../models/upload.model';
import { IUploadRepository, UPLOAD_REPOSITORY } from '../repositories/upload.repository';

@Injectable()
export class CompleteUploadUseCase {
  private readonly logger = new Logger('OCR-PIPELINE/complete-upload');

  constructor(
    @Inject(UPLOAD_REPOSITORY) private readonly uploads: IUploadRepository,
    @Inject(OCR_JOB_REPOSITORY) private readonly ocrJobs: IOcrJobRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: IObjectStorage,
    @Inject(OCR_DISPATCHER) private readonly dispatcher: IOcrDispatcher,
  ) {}

  async execute(input: { actor: AuthenticatedUser; id: string }): Promise<UploadModel> {
    const t = new StageTimer();
    this.logger.log(`[1/5] complete requested upload=${input.id} by=${input.actor.sub}`);

    const upload = await this.uploads.findById(input.actor.tenantId, input.id);
    if (!upload) {
      this.logger.warn(`[reject] upload ${input.id} not found for tenant ${input.actor.tenantId}`);
      throw new NotFoundException('Upload not found');
    }

    if (input.actor.role === Role.TEACHER && upload.uploadedBy !== input.actor.sub) {
      this.logger.warn(
        `[reject] teacher ${input.actor.sub} cannot complete upload owned by ${upload.uploadedBy}`,
      );
      throw new ForbiddenException('Teachers can only complete their own uploads');
    }

    if (upload.status !== 'PENDING_UPLOAD') {
      this.logger.warn(
        `[reject] upload ${upload.id} in status ${upload.status}, not PENDING_UPLOAD`,
      );
      throw new ConflictException(`Upload is in status ${upload.status}; cannot complete`);
    }

    const exists = await this.storage.objectExists(upload.storageKey);
    if (!exists) {
      this.logger.error(
        `[FAIL] object missing at storage key="${upload.storageKey}". Client PUT/POST to signed URL likely failed.`,
      );
      throw new BadRequestException(
        'Object not present in storage. Did the PUT to the signed URL succeed?',
      );
    }
    this.logger.log(`[2/5] storage HEAD ok ${t.mark()} (key=${upload.storageKey.slice(-40)})`);

    // Question images are embedded directly into question HTML — they are NOT
    // OCR papers. Skip the OCR pipeline entirely: feeding an arbitrary image to
    // Tesseract is wasteful and a malformed one can crash the worker. The FE
    // only needs the object to exist + the storageKey it already holds, so
    // marking UPLOADED (terminal, no OCR) is sufficient.
    if (upload.storageKey.includes('/question-images/') || upload.storageKey.includes('/answer-keys/')) {
      const done = await this.uploads.updateStatus(upload.tenantId, upload.id, 'UPLOADED');
      this.logger.log(
        `[done] question-image upload ${upload.id} marked UPLOADED — OCR skipped ${t.mark()} (${t.totalLabel()})`,
      );
      return done;
    }

    const existingJob = await this.ocrJobs.findByUploadId(upload.tenantId, upload.id);
    const ocrJob =
      existingJob ??
      (await this.ocrJobs.create({ tenantId: upload.tenantId, uploadId: upload.id }));
    this.logger.log(`[3/5] ocr job ${ocrJob.id} ${existingJob ? '(reused)' : '(new)'} ${t.mark()}`);

    await this.uploads.updateStatus(upload.tenantId, upload.id, 'UPLOADED');
    const processed = await this.uploads.updateStatus(upload.tenantId, upload.id, 'PROCESSING');
    this.logger.log(`[4/5] status PENDING_UPLOAD → UPLOADED → PROCESSING ${t.mark()}`);

    // Hand off to the configured OCR backend (BullMQ or in-process inline).
    // Both return promptly — the upload is acked as PROCESSING and OCR runs
    // asynchronously, so the client is never blocked on extraction.
    await this.dispatcher.enqueue({
      ocrJobId: ocrJob.id,
      tenantId: upload.tenantId,
      uploadId: upload.id,
      storageKey: upload.storageKey,
    });
    this.logger.log(
      `[5/5] dispatched ${t.mark()} — OCR backend takes over (${t.totalLabel()} to ack client)`,
    );

    return processed;
  }
}
