import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Role } from '../../shared/common/enums/role.enum';
import { StageTimer } from '../../shared/common/utils/stage-timer';
import { IObjectStorage, OBJECT_STORAGE } from '../../shared/storage/object-storage.interface';
import { AuthenticatedUser } from '../auth/models/authenticated-user.model';
import { IUploadRepository, UPLOAD_REPOSITORY } from '../uploads/repositories/upload.repository';
import { PageReflowSummary, reflowPdf } from './pdf-reflow';

export interface PreprocessResult {
  uploadId: string;
  /** false ⇒ original object left untouched (single-column / no confident multi-column). */
  changed: boolean;
  pageCount: number;
  reflowedPages: number;
  /** Per-page debug summary: page, detectedColumns, confidence, action. */
  pages: PageReflowSummary[];
  /** Why the whole upload was skipped without rendering (non-PDF / not-a-paper), if any. */
  skipped?: string;
}

/**
 * OCR PREPROCESS — a NEW orchestration layer that runs BETWEEN the browser's storage PUT
 * and POST /uploads/:id/complete. It reflows confidently-detected true multi-column exam
 * PDFs to single-column so the UNCHANGED OCR pipeline crops each question at full width.
 *
 * It NEVER touches CompleteUploadUseCase / OcrJobRunner / the OCR engine: it only reads
 * the stored object, optionally rewrites it in place, and returns. complete-upload then
 * dispatches OCR exactly as before. Best-effort: any failure leaves the original object
 * untouched and reports changed:false, so the upload can always proceed to complete.
 */
@Injectable()
export class OcrPreprocessService {
  private readonly logger = new Logger('OCR-PREPROCESS/column-reflow');

  constructor(
    @Inject(UPLOAD_REPOSITORY) private readonly uploads: IUploadRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: IObjectStorage,
  ) {}

  async execute(input: { actor: AuthenticatedUser; uploadId: string }): Promise<PreprocessResult> {
    const t = new StageTimer();
    const upload = await this.uploads.findById(input.actor.tenantId, input.uploadId);
    if (!upload) throw new NotFoundException('Upload not found');
    if (input.actor.role === Role.TEACHER && upload.uploadedBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only preprocess their own uploads');
    }

    const noop = (skipped: string): PreprocessResult => {
      this.logger.log(`upload=${upload.id} skip (${skipped}) ${t.totalLabel()}`);
      return { uploadId: upload.id, changed: false, pageCount: 0, reflowedPages: 0, pages: [], skipped };
    };

    // Only true exam-paper PDFs are candidates. Question-images / answer-keys are not OCR
    // papers (complete-upload skips OCR for them too); single images aren't multi-column.
    if (upload.storageKey.includes('/question-images/') || upload.storageKey.includes('/answer-keys/')) {
      return noop('not an OCR paper');
    }
    if ((upload.mimeType ?? '').toLowerCase() !== 'application/pdf' && !upload.storageKey.toLowerCase().endsWith('.pdf')) {
      return noop('not a PDF');
    }

    // The bytes must already be in storage (browser PUT done). If not, this is a no-op —
    // complete-upload will surface the missing-object error in its own pre-flight check.
    const exists = await this.storage.objectExists(upload.storageKey);
    if (!exists) return noop('object not yet in storage');

    try {
      const { body, contentType } = await this.storage.getObject(upload.storageKey);
      this.logger.log(`upload=${upload.id} fetched ${body.length}B ${t.mark()}`);

      const result = await reflowPdf(body);
      this.logger.log(
        `upload=${upload.id} detected ${result.pageCount} pages, reflowed ${result.reflowedPages} ${t.mark()}`,
      );

      if (result.changed && result.pdf) {
        await this.storage.putObject(upload.storageKey, result.pdf, contentType || 'application/pdf');
        this.logger.log(
          `upload=${upload.id} REFLOWED ${result.reflowedPages}/${result.pageCount} pages → object rewritten ${t.mark()} (${t.totalLabel()})`,
        );
      } else {
        this.logger.log(`upload=${upload.id} NO-OP — original object untouched ${t.totalLabel()}`);
      }

      return {
        uploadId: upload.id,
        changed: result.changed,
        pageCount: result.pageCount,
        reflowedPages: result.reflowedPages,
        pages: result.summary,
      };
    } catch (err) {
      // Never break the upload: on any failure leave the original object as-is and let the
      // normal complete-upload → OCR flow proceed on the untouched bytes.
      this.logger.error(
        `upload=${upload.id} preprocess FAILED — leaving original untouched: ${err instanceof Error ? err.message : String(err)}`,
      );
      return noop('preprocess error (original untouched)');
    }
  }
}
