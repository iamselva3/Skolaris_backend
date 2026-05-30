export type UploadStatus =
  | 'PENDING_UPLOAD'
  | 'UPLOADED'
  | 'PROCESSING'
  | 'READY_FOR_REVIEW'
  | 'APPROVED'
  | 'FAILED';

export class UploadModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly uploadedBy: string,
    public readonly originalName: string,
    public readonly mimeType: string,
    public readonly sizeBytes: bigint | null,
    public readonly storageKey: string,
    public readonly status: UploadStatus,
    public readonly errorMessage: string | null,
    public readonly programId: string | null,
    public readonly subjectId: string | null,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
    /**
     * Populated only by the list/findById queries via Prisma include of
     * ocrJob._count.drafts. Null when there's no OCR job yet (e.g. PENDING_UPLOAD)
     * or when the loader didn't include it.
     */
    public readonly draftCount: number | null = null,
  ) {}
}

export const ALLOWED_UPLOAD_MIME_TYPES = new Set<string>([
  'application/pdf',
  'image/jpeg',
  'image/jpg',   // some browsers/clients send the non-standard variant; normalized to image/jpeg below
  'image/png',
  'image/webp',
  'image/heic',
]);

/**
 * Map non-standard / synonymous mime variants to the canonical form the
 * pipeline downstream expects. Defensive — protects against older browsers
 * and drag-and-drop edge cases where the File.type isn't perfectly normalized.
 */
export const normalizeMimeType = (raw: string): string => {
  const v = raw.trim().toLowerCase();
  if (v === 'image/jpg') return 'image/jpeg';
  return v;
};
