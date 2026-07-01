import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Role } from '../../shared/common/enums/role.enum';
import { StageTimer } from '../../shared/common/utils/stage-timer';
import { IObjectStorage, OBJECT_STORAGE } from '../../shared/storage/object-storage.interface';
import { AuthenticatedUser } from '../auth/models/authenticated-user.model';
import { profilePdf } from '../document-profiler/pdf-profiler';
import { IUploadRepository, UPLOAD_REPOSITORY } from '../uploads/repositories/upload.repository';
import { Candidate, enhanceWithPdfLib } from './pdf-lib-enhancer';
import { fallbackWithPdfcpu, isPdfcpuAvailable } from './pdfcpu-fallback';

export interface EnhancementResult {
  uploadId: string;
  /** False ⇒ enhancement does not apply (not a digital PDF). Use the original. */
  applicable: boolean;
  verdict: 'DIGITAL' | 'SCANNED';
  /** True ⇒ an enhanced draft was written to `enhancedStorageKey`. */
  changed: boolean;
  removed: Candidate[];
  declined: Candidate[];
  originalStorageKey: string;
  /** Present only when changed:true. The ORIGINAL is always preserved at originalStorageKey. */
  enhancedStorageKey?: string;
  /** Which package, if any, produced the enhanced draft. */
  enhancedBy?: 'pdf-lib' | 'pdfcpu';
  recommendedAction: 'PREVIEW' | 'BYPASS';
  notes: string[];
}

export type SelectableVersion = 'original' | 'enhanced';

export interface SelectResult {
  uploadId: string;
  applied: SelectableVersion;
  /** When 'enhanced' is applied, the untouched original is preserved here. */
  originalPreservedAt?: string;
  note: string;
}

/** Insert a suffix before the file extension of a storage key. */
const withSuffix = (key: string, suffix: string): string => {
  const slash = key.lastIndexOf('/');
  const dot = key.lastIndexOf('.');
  if (dot > slash) return `${key.slice(0, dot)}${suffix}${key.slice(dot)}`;
  return `${key}${suffix}.pdf`;
};
const enhancedKeyOf = (key: string): string => withSuffix(key, '.enhanced');
const preservedOriginalKeyOf = (key: string): string => withSuffix(key, '.original');

/**
 * DOCUMENT ENHANCEMENT (Phase 2) — optional, additive, BEFORE OCR.
 *
 * Flow: profile → (DIGITAL only) pdf-lib safe removal → if pdf-lib could not act,
 * pdfcpu fallback FROM THE ORIGINAL → write an ENHANCED DRAFT to a SEPARATE key.
 * The original object is NEVER modified by enhancement; the user previews
 * Original vs Enhanced and selects one. It imports NONE of the OCR engine /
 * analyzer / detectors / lifecycle / delivery / preprocess — it only reads the
 * upload + object storage. Golden Rule: on any uncertainty/failure → safe no-op
 * (extract the original).
 */
@Injectable()
export class DocumentEnhancementService {
  private readonly logger = new Logger('DOCUMENT-ENHANCEMENT');

  constructor(
    @Inject(UPLOAD_REPOSITORY) private readonly uploads: IUploadRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: IObjectStorage,
  ) {}

  async enhance(input: {
    actor: AuthenticatedUser;
    uploadId: string;
  }): Promise<EnhancementResult> {
    const t = new StageTimer();
    const upload = await this.uploads.findById(input.actor.tenantId, input.uploadId);
    if (!upload) throw new NotFoundException('Upload not found');
    if (input.actor.role === Role.TEACHER && upload.uploadedBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only enhance their own uploads');
    }

    const mime = (upload.mimeType ?? '').toLowerCase();
    const isPdf = mime === 'application/pdf' || upload.storageKey.toLowerCase().endsWith('.pdf');

    const noop = (
      applicable: boolean,
      verdict: 'DIGITAL' | 'SCANNED',
      declined: Candidate[],
      notes: string[],
    ): EnhancementResult => ({
      uploadId: upload.id,
      applicable,
      verdict,
      changed: false,
      removed: [],
      declined,
      originalStorageKey: upload.storageKey,
      recommendedAction: 'BYPASS',
      notes,
    });

    if (!isPdf) {
      return noop(false, 'SCANNED', [], ['Not a PDF — enhancement does not apply; extract the original.']);
    }

    const exists = await this.storage.objectExists(upload.storageKey).catch(() => false);
    if (!exists) {
      return noop(false, 'SCANNED', [], ['Object not yet in storage — extract the original.']);
    }

    try {
      const { body } = await this.storage.getObject(upload.storageKey);

      // Gate: only DIGITAL PDFs are enhancement-eligible (uncertain/scanned → bypass).
      const profile = await profilePdf(body);
      if (profile.verdict !== 'DIGITAL') {
        this.logger.log(`upload=${upload.id} ${profile.verdict} → BYPASS ${t.totalLabel()}`);
        return noop(false, profile.verdict, [], [
          'Scanned/uncertain PDF — KEEP THE PIXELS. Extract the original through the unchanged OCR pipeline.',
        ]);
      }

      // PRIMARY: pdf-lib safe structural removal (from the ORIGINAL bytes).
      const pl = await enhanceWithPdfLib(body, {
        repeatedXObjects: profile.repeatedXObjects,
        ocgLayers: profile.ocgLayers,
      });
      let finalBytes = pl.pdf;
      let removed = pl.removed;
      const declined = pl.declined;
      let enhancedBy: 'pdf-lib' | 'pdfcpu' | undefined = pl.pdf ? 'pdf-lib' : undefined;

      // SECONDARY (fallback): ONLY if pdf-lib could not act (errored / produced nothing).
      // Works from the ORIGINAL so no object is touched by two packages.
      if (!finalBytes && (pl.errored || removed.length === 0) && isPdfcpuAvailable()) {
        const fb = fallbackWithPdfcpu(body);
        if (fb.pdf) {
          finalBytes = fb.pdf;
          removed = fb.removed;
          enhancedBy = 'pdfcpu';
        }
      }

      const notes: string[] = [];
      if (pl.errored) notes.push(`pdf-lib could not process the document (${pl.errorMessage ?? 'unknown'}).`);

      if (finalBytes && removed.length > 0) {
        const enhancedStorageKey = enhancedKeyOf(upload.storageKey);
        await this.storage.putObject(enhancedStorageKey, finalBytes, 'application/pdf');
        this.logger.log(
          `upload=${upload.id} ENHANCED by ${enhancedBy}: removed ${removed.length} → draft ${enhancedStorageKey} (original preserved) ${t.totalLabel()}`,
        );
        notes.push('Original preserved; enhanced draft saved separately. Preview both, then select.');
        return {
          uploadId: upload.id,
          applicable: true,
          verdict: 'DIGITAL',
          changed: true,
          removed,
          declined,
          originalStorageKey: upload.storageKey,
          enhancedStorageKey,
          enhancedBy,
          recommendedAction: 'PREVIEW',
          notes,
        };
      }

      // Nothing safely removable → safe no-op. Extract the original.
      this.logger.log(`upload=${upload.id} DIGITAL but no safe removals → NO-OP ${t.totalLabel()}`);
      notes.push('No safely-removable decoration found — safe no-op. Extract the original.');
      return {
        uploadId: upload.id,
        applicable: true,
        verdict: 'DIGITAL',
        changed: false,
        removed: [],
        declined,
        originalStorageKey: upload.storageKey,
        recommendedAction: 'BYPASS',
        notes,
      };
    } catch (err) {
      // Enhancement must NEVER break the upload. On any failure → safe no-op.
      this.logger.error(
        `upload=${upload.id} enhancement FAILED — safe no-op (extract original): ${err instanceof Error ? err.message : String(err)}`,
      );
      return noop(true, 'DIGITAL', [], ['Enhancement failed — extract the original (unchanged OCR pipeline).']);
    }
  }

  /**
   * Apply the user's choice. 'original' is a no-op (the object is already the
   * original). 'enhanced' preserves the original to a sibling key, then copies the
   * enhanced draft over the upload's storageKey so the UNCHANGED complete/dispatch
   * path feeds the enhanced bytes to OCR (same in-place pattern as ocr-preprocess).
   */
  async select(input: {
    actor: AuthenticatedUser;
    uploadId: string;
    version: SelectableVersion;
  }): Promise<SelectResult> {
    const upload = await this.uploads.findById(input.actor.tenantId, input.uploadId);
    if (!upload) throw new NotFoundException('Upload not found');
    if (input.actor.role === Role.TEACHER && upload.uploadedBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only modify their own uploads');
    }

    if (input.version === 'original') {
      return {
        uploadId: upload.id,
        applied: 'original',
        note: 'Original selected — nothing changed; extract proceeds on the original.',
      };
    }

    const enhancedKey = enhancedKeyOf(upload.storageKey);
    const enhancedExists = await this.storage.objectExists(enhancedKey).catch(() => false);
    if (!enhancedExists) {
      throw new NotFoundException('No enhanced draft exists for this upload');
    }

    // Preserve the untouched original to a sibling key (idempotent).
    const preservedKey = preservedOriginalKeyOf(upload.storageKey);
    const preservedExists = await this.storage.objectExists(preservedKey).catch(() => false);
    if (!preservedExists) {
      const original = await this.storage.getObject(upload.storageKey);
      await this.storage.putObject(preservedKey, original.body, original.contentType || 'application/pdf');
    }

    // Copy the enhanced draft over the live object so the UNCHANGED OCR dispatch reads it.
    const enhanced = await this.storage.getObject(enhancedKey);
    await this.storage.putObject(upload.storageKey, enhanced.body, 'application/pdf');
    this.logger.log(`upload=${upload.id} ENHANCED selected → live object swapped; original preserved at ${preservedKey}`);

    return {
      uploadId: upload.id,
      applied: 'enhanced',
      originalPreservedAt: preservedKey,
      note: 'Enhanced selected — original preserved; extract proceeds on the enhanced draft.',
    };
  }
}
