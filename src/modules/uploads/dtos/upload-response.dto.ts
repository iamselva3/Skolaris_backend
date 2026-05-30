import { UploadModel } from '../models/upload.model';

export interface UploadResponse {
  id: string;
  tenantId: string;
  uploadedBy: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number | null;
  storageKey: string;
  status: string;
  errorMessage: string | null;
  programId: string | null;
  subjectId: string | null;
  /** OCR drafts attached to this upload's job. null if no OCR job yet or not loaded. */
  draftCount: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SignedUploadResponse extends UploadResponse {
  signedUrl: string;
  expiresAt: string;
  /** HTTP method the client must use ('PUT' for real GCS/S3, 'POST' for fake-gcs). */
  httpMethod: 'PUT' | 'POST';
  requiredHeaders?: Record<string, string>;
}

export const toUploadResponse = (u: UploadModel): UploadResponse => ({
  id: u.id,
  tenantId: u.tenantId,
  uploadedBy: u.uploadedBy,
  originalName: u.originalName,
  mimeType: u.mimeType,
  sizeBytes: u.sizeBytes !== null ? Number(u.sizeBytes) : null,
  storageKey: u.storageKey,
  status: u.status,
  errorMessage: u.errorMessage,
  programId: u.programId,
  subjectId: u.subjectId,
  draftCount: u.draftCount,
  createdAt: u.createdAt.toISOString(),
  updatedAt: u.updatedAt.toISOString(),
});
