export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export interface SignedUploadUrl {
  signedUrl: string;
  storageKey: string;
  expiresAt: Date;
  /** HTTP method the client must use for the presigned upload (S3/R2 → PUT). */
  httpMethod: 'PUT';
  /**
   * Additional headers the client MUST send with its upload for it to succeed.
   * Currently just Content-Type for S3/R2 presigned PUTs.
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
   * Read object bytes + content-type. Backs the read proxy
   * (StorageReadController) so the frontend's existing `/storage/v1/b/.../o/...`
   * read URLs and the standalone OCR worker's `/download/...` fetch keep working
   * against the private R2/S3 bucket with no frontend change. The in-process OCR
   * consumer calls this directly via DI (no HTTP round-trip).
   */
  getObject(storageKey: string): Promise<ObjectData>;
}
