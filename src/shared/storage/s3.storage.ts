import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { storageConfig } from '../config/storage.config';
import {
  CreateSignedUploadInput,
  IObjectStorage,
  ObjectData,
  SignedUploadUrl,
} from './object-storage.interface';

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
};
const inferMime = (key: string): string => EXT_MIME[key.toLowerCase().split('.').pop() ?? ''] ?? 'application/octet-stream';

/**
 * S3-compatible object storage. Works with real AWS S3, Cloudflare R2, and
 * MinIO. For R2 set S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com,
 * AWS_REGION=auto, S3_FORCE_PATH_STYLE=true.
 *
 * Two clients: the main one (internal `endpoint`) handles server-side ops
 * (Head/Get/Delete); presigned UPLOAD URLs are signed with the
 * browser-reachable `publicEndpoint` when it differs (e.g. MinIO behind docker).
 * Reads are served by the backend proxy (StorageReadController) via getObject,
 * so private R2 buckets need no public read URL and the frontend is unchanged.
 */
@Injectable()
export class S3Storage implements IObjectStorage {
  private readonly logger = new Logger(S3Storage.name);
  // Lazy: S3Client construction is deferred to first use so DI wiring never
  // fails at bootstrap; AWS_S3_BUCKET/AWS_REGION are validated in storageConfig.
  private _client: S3Client | null = null;
  private _signClient: S3Client | null = null;
  private readonly bucket: string;

  constructor(@Inject(storageConfig.KEY) private readonly cfg: ConfigType<typeof storageConfig>) {
    this.bucket = this.cfg.s3.bucket;
  }

  private build(endpoint: string | null): S3Client {
    if (!this.cfg.s3.region) {
      throw new Error('AWS_REGION is required when STORAGE_PROVIDER=s3 (use "auto" for R2)');
    }
    return new S3Client({
      region: this.cfg.s3.region,
      endpoint: endpoint ?? undefined,
      forcePathStyle: this.cfg.s3.forcePathStyle,
      // AWS SDK v3 >= 3.729 defaults requestChecksumCalculation to
      // 'WHEN_SUPPORTED', which bakes an x-amz-checksum-crc32 (placeholder
      // AAAAAA== for empty content) into PRESIGNED PutObject URLs. The browser
      // then PUTs the real bytes, R2 recomputes a different CRC32, and the
      // signed checksum no longer matches → HTTP 400. R2 (and MinIO/GCS) are not
      // compatible with this default. Force WHEN_REQUIRED so no checksum query
      // params are signed unless an operation genuinely needs them (PutObject
      // does not), restoring pre-3.729 presigning behaviour.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials:
        this.cfg.s3.accessKeyId && this.cfg.s3.secretAccessKey
          ? { accessKeyId: this.cfg.s3.accessKeyId, secretAccessKey: this.cfg.s3.secretAccessKey }
          : undefined,
    });
  }

  /** Internal client for server-side operations (Head/Get/Delete). */
  private client(): S3Client {
    if (this._client === null) this._client = this.build(this.cfg.s3.endpoint);
    return this._client;
  }

  /** Client whose endpoint is browser-reachable — used to sign upload URLs. */
  private signClient(): S3Client {
    const pub = this.cfg.s3.publicEndpoint;
    if (!pub || pub === this.cfg.s3.endpoint) return this.client();
    if (this._signClient === null) this._signClient = this.build(pub);
    return this._signClient;
  }

  async createSignedUploadUrl(input: CreateSignedUploadInput): Promise<SignedUploadUrl> {
    // NOTE: we intentionally do NOT sign ContentLength. Signing
    // ContentLength=maxBytes forces the client to send exactly that many bytes,
    // and R2 enforces the signed value strictly (SignatureDoesNotMatch). Size is
    // still bounded by UPLOAD_MAX_BYTES at key-build/validation time.
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.storageKey,
      ContentType: input.contentType,
    });
    const signedUrl = await getSignedUrl(this.signClient(), cmd, { expiresIn: input.ttlSeconds });
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
    return {
      signedUrl,
      storageKey: input.storageKey,
      expiresAt,
      httpMethod: 'PUT',
      requiredHeaders: { 'Content-Type': input.contentType },
    };
  }

  async deleteObject(storageKey: string): Promise<void> {
    try {
      await this.client().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }));
    } catch (err) {
      this.logger.warn(`Failed to delete ${storageKey}: ${(err as Error).message}`);
    }
  }

  async objectExists(storageKey: string): Promise<boolean> {
    try {
      await this.client().send(new HeadObjectCommand({ Bucket: this.bucket, Key: storageKey }));
      return true;
    } catch {
      return false;
    }
  }

  async getObject(storageKey: string): Promise<ObjectData> {
    const res = await this.client().send(
      new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
    );
    if (!res.Body) throw new Error(`Empty body for ${storageKey}`);
    const bytes = await (res.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
    return { body: Buffer.from(bytes), contentType: res.ContentType ?? inferMime(storageKey) };
  }
}
