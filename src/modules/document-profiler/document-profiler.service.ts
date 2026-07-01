import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Role } from '../../shared/common/enums/role.enum';
import { StageTimer } from '../../shared/common/utils/stage-timer';
import { IObjectStorage, OBJECT_STORAGE } from '../../shared/storage/object-storage.interface';
import { AuthenticatedUser } from '../auth/models/authenticated-user.model';
import { IUploadRepository, UPLOAD_REPOSITORY } from '../uploads/repositories/upload.repository';
import { PdfProfile, profilePdf } from './pdf-profiler';

export type DocumentSource = 'pdf' | 'image' | 'other';
export type DocumentType = 'DIGITAL_PDF' | 'SCANNED_PDF' | 'IMAGE' | 'UNKNOWN';

/**
 * The Phase-1 contract returned to the frontend. It is purely INFORMATIONAL:
 * the profiler writes nothing and changes no OCR behaviour. The FE uses
 * `recommendedPath` to decide whether to offer the (future) enhancement preview
 * or send the user straight to Extract.
 *
 * `enhancementEligible === true` is the ONE gate that a later phase's mutation
 * is allowed to act on. It is true only for a confidently DIGITAL pdf.
 */
export interface DocumentProfileResult {
  uploadId: string;
  source: DocumentSource;
  documentType: DocumentType;
  verdict: 'DIGITAL' | 'SCANNED';
  confidence: number;
  reason: string;
  enhancementEligible: boolean;
  recommendedPath: 'ENHANCE' | 'BYPASS';
  /**
   * Paper characteristics. Phase 1 derives these from PDF STRUCTURE only and
   * never renders pixels, so brightness (and colour, when no structural
   * background fill is declared) are reported as null. They are filled in by the
   * render pass that ships alongside the phase that actually consumes them
   * (enhancement / image flatten).
   */
  paper: { color: string | null; brightness: number | null; derivedFrom: 'structure' | 'unavailable' };
  /** Present only for PDFs that were successfully parsed. */
  pdf?: PdfProfile;
  notes: string[];
}

const PDF_MIMES = new Set(['application/pdf']);
const IMAGE_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic']);

/**
 * DOCUMENT PROFILER (Phase 1) — a NEW read-only analysis layer that runs AFTER the
 * browser's storage PUT and BEFORE POST /uploads/:id/complete, mirroring the
 * ocr-preprocess endpoint placement:
 *
 *   create upload → PUT bytes → POST /document-profile/:uploadId → (preview) → complete
 *
 * It NEVER mutates the stored object, never touches CompleteUploadUseCase /
 * OcrJobRunner / the OCR engine / the 8 detectors / ocr-preprocess. It only reads
 * the bytes, classifies digital-vs-scanned from the document's own structure, and
 * returns a profile. Golden Rule: on ANY uncertainty or failure it reports
 * SCANNED / BYPASS so the unchanged OCR pipeline runs on the original bytes.
 */
@Injectable()
export class DocumentProfilerService {
  private readonly logger = new Logger('DOCUMENT-PROFILER');

  constructor(
    @Inject(UPLOAD_REPOSITORY) private readonly uploads: IUploadRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: IObjectStorage,
  ) {}

  async execute(input: {
    actor: AuthenticatedUser;
    uploadId: string;
  }): Promise<DocumentProfileResult> {
    const t = new StageTimer();
    const upload = await this.uploads.findById(input.actor.tenantId, input.uploadId);
    if (!upload) throw new NotFoundException('Upload not found');
    if (input.actor.role === Role.TEACHER && upload.uploadedBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only profile their own uploads');
    }

    const mime = (upload.mimeType ?? '').toLowerCase();
    const key = upload.storageKey.toLowerCase();
    const isPdf = PDF_MIMES.has(mime) || key.endsWith('.pdf');
    const isImage =
      IMAGE_MIMES.has(mime) ||
      /\.(jpe?g|png|webp|heic)$/.test(key);

    const bypass = (
      source: DocumentSource,
      documentType: DocumentType,
      confidence: number,
      reason: string,
      notes: string[],
      pdf?: PdfProfile,
    ): DocumentProfileResult => ({
      uploadId: upload.id,
      source,
      documentType,
      verdict: 'SCANNED',
      confidence,
      reason,
      enhancementEligible: false,
      recommendedPath: 'BYPASS',
      paper: { color: null, brightness: null, derivedFrom: 'unavailable' },
      pdf,
      notes,
    });

    // Image uploads: Phase 1 always bypasses. Image normalization is Phase 4 (Sharp);
    // there is no digital-object enhancement to do, so KEEP THE PIXELS → OCR pipeline.
    if (isImage && !isPdf) {
      this.logger.log(`upload=${upload.id} image → BYPASS ${t.totalLabel()}`);
      return bypass('image', 'IMAGE', 1, 'image upload — bypass enhancement (Phase 4 handles image normalization)', [
        'Images are sent straight to the existing OCR pipeline in Phase 1.',
      ]);
    }

    if (!isPdf) {
      this.logger.log(`upload=${upload.id} non-pdf/non-image (${mime}) → BYPASS ${t.totalLabel()}`);
      return bypass('other', 'UNKNOWN', 1, `unsupported type for enhancement (${mime || 'unknown'})`, [
        'Only digital PDFs are enhancement-eligible.',
      ]);
    }

    // PDF path. Bytes must already be in storage (browser PUT done).
    const exists = await this.storage.objectExists(upload.storageKey).catch(() => false);
    if (!exists) {
      this.logger.log(`upload=${upload.id} object not in storage yet → BYPASS ${t.totalLabel()}`);
      return bypass('pdf', 'UNKNOWN', 0.5, 'object not yet in storage', [
        'Profile after the browser PUT completes.',
      ]);
    }

    try {
      const { body } = await this.storage.getObject(upload.storageKey);
      this.logger.log(`upload=${upload.id} fetched ${body.length}B ${t.mark()}`);

      const profile = await profilePdf(body);
      const isDigital = profile.verdict === 'DIGITAL';
      this.logger.log(
        `upload=${upload.id} ${profile.verdict} conf=${profile.confidence} ` +
          `native=${profile.nativePageRatio} imgDom=${profile.imageDominatedRatio} ` +
          `(${profile.sampledPages}/${profile.pageCount} pages) ${t.mark()} (${t.totalLabel()})`,
      );

      const notes = [
        isDigital
          ? 'Digital PDF — eligible for safe structural enhancement (preview before Extract).'
          : 'Scanned PDF — KEEP THE PIXELS. Bypass enhancement; the unchanged OCR pipeline handles it.',
      ];
      if (profile.watermarkConfidence > 0) {
        notes.push(
          `Structural watermark signal ${profile.watermarkConfidence} (annotation/OCG/repeated object) — informational only in Phase 1.`,
        );
      }

      return {
        uploadId: upload.id,
        source: 'pdf',
        documentType: isDigital ? 'DIGITAL_PDF' : 'SCANNED_PDF',
        verdict: profile.verdict,
        confidence: profile.confidence,
        reason: profile.reason,
        enhancementEligible: isDigital,
        recommendedPath: isDigital ? 'ENHANCE' : 'BYPASS',
        paper: { color: null, brightness: null, derivedFrom: 'unavailable' },
        pdf: profile,
        notes,
      };
    } catch (err) {
      // Profiling must NEVER break the upload. On any failure → SCANNED/BYPASS so the
      // original bytes flow through the unchanged OCR pipeline exactly as today.
      this.logger.error(
        `upload=${upload.id} profile FAILED — defaulting to SCANNED/BYPASS: ${err instanceof Error ? err.message : String(err)}`,
      );
      return bypass('pdf', 'SCANNED_PDF', 0.5, 'profiler error — treated as scanned (keep pixels)', [
        'Profiling failed; the original bytes proceed to the unchanged OCR pipeline.',
      ]);
    }
  }
}
