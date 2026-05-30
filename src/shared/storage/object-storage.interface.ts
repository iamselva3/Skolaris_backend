export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export interface SignedUploadUrl {
  signedUrl: string;
  storageKey: string;
  expiresAt: Date;
  /**
   * HTTP method the client must use. Defaults to PUT (real GCS v4 / S3
   * presigned URLs). fake-gcs-server's JSON simple-upload endpoint requires
   * POST, so the emulator branch returns 'POST'.
   */
  httpMethod: 'PUT' | 'POST';
  /**
   * Some providers require additional headers (e.g. `x-goog-content-length-range`)
   * that the client MUST send with its upload for it to succeed.
   */
  requiredHeaders?: Record<string, string>;
}

export interface CreateSignedUploadInput {
  storageKey: string;
  contentType: string;
  ttlSeconds: number;
  maxBytes: number;
}

export interface ObjectData {
  body: Buffer;
  contentType: string;
}

export interface IObjectStorage {
  createSignedUploadUrl(input: CreateSignedUploadInput): Promise<SignedUploadUrl>;
  deleteObject(storageKey: string): Promise<void>;
  /**
   * True if the object exists. Used by `POST /uploads/:id/complete` to verify the
   * client really uploaded the bytes before flipping status to UPLOADED.
   */
  objectExists(storageKey: string): Promise<boolean>;
  /**
   * Read object bytes + content-type. Backs the GCS-compatible read proxy
   * (StorageReadController) so the frontend's existing `/storage/v1/b/.../o/...`
   * read URLs and the OCR `/download/...` fetch keep working against any provider
   * (notably private R2/S3 buckets) with NO frontend or OCR code change.
   */
  getObject(storageKey: string): Promise<ObjectData>;
}
