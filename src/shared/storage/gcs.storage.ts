import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Bucket, Storage } from '@google-cloud/storage';
import { storageConfig } from '../config/storage.config';
import {
  CreateSignedUploadInput,
  IObjectStorage,
  ObjectData,
  SignedUploadUrl,
} from './object-storage.interface';

@Injectable()
export class GcsStorage implements IObjectStorage, OnApplicationBootstrap {
  private readonly logger = new Logger(GcsStorage.name);
  private readonly storage: Storage;
  private readonly bucket: Bucket;
  private readonly publicHost: string | null;
  private readonly isFakeEndpoint: boolean;

  constructor(@Inject(storageConfig.KEY) private readonly cfg: ConfigType<typeof storageConfig>) {
    this.isFakeEndpoint = Boolean(this.cfg.gcs.apiEndpoint);
    this.publicHost = this.cfg.gcs.publicHost ?? this.cfg.gcs.apiEndpoint ?? null;

    this.storage = new Storage({
      projectId: this.cfg.gcs.projectId ?? undefined,
      apiEndpoint: this.cfg.gcs.apiEndpoint ?? undefined,
      keyFilename: this.cfg.gcs.serviceAccountJsonPath ?? undefined,
    });
    this.bucket = this.storage.bucket(this.cfg.gcs.bucket);

    if (this.isFakeEndpoint) {
      this.logger.warn(
        `GCS configured against non-prod endpoint ${this.cfg.gcs.apiEndpoint} (fake-gcs-server). Signed URLs will be unauthenticated PUTs.`,
      );
    }
  }

  /**
   * Defensive: ensure the bucket exists at startup. Real GCS will return 409
   * if the bucket is already owned by another project, but for fake-gcs-server
   * this is the cheapest way to recover from a stale data volume that lost
   * the bucket directory between runs.
   *
   * Skipped if not the active provider (S3 deployment).
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.cfg.provider !== 'gcs') return;
    try {
      const [exists] = await this.bucket.exists();
      if (exists) return;
      await this.bucket.create();
      this.logger.log(`Created storage bucket "${this.cfg.gcs.bucket}"`);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      // 409 = bucket already exists (race / owned). Anything else, log and continue
      // so a transient storage outage doesn't take down the API.
      if (/already.*exists|409/i.test(message)) return;
      this.logger.warn(
        `Bucket bootstrap check failed for "${this.cfg.gcs.bucket}": ${message}`,
      );
    }
  }

  async createSignedUploadUrl(input: CreateSignedUploadInput): Promise<SignedUploadUrl> {
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
    const file = this.bucket.file(input.storageKey);

    if (this.isFakeEndpoint) {
      // fake-gcs-server's simple-upload endpoint accepts POST (NOT PUT) to
      // /upload/storage/v1/b/<bucket>/o?uploadType=media&name=<obj>. Client
      // must honour httpMethod='POST'.
      const host = (this.publicHost ?? this.cfg.gcs.apiEndpoint ?? '').replace(/\/+$/, '');
      const signedUrl = `${host}/upload/storage/v1/b/${encodeURIComponent(
        this.cfg.gcs.bucket,
      )}/o?uploadType=media&name=${encodeURIComponent(input.storageKey)}`;
      return {
        signedUrl,
        storageKey: input.storageKey,
        expiresAt,
        httpMethod: 'POST',
        requiredHeaders: { 'Content-Type': input.contentType },
      };
    }

    const [signedUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: expiresAt,
      contentType: input.contentType,
      extensionHeaders: {
        'x-goog-content-length-range': `0,${input.maxBytes}`,
      },
    });
    return {
      signedUrl,
      storageKey: input.storageKey,
      expiresAt,
      httpMethod: 'PUT',
      requiredHeaders: {
        'Content-Type': input.contentType,
        'x-goog-content-length-range': `0,${input.maxBytes}`,
      },
    };
  }

  async deleteObject(storageKey: string): Promise<void> {
    try {
      await this.bucket.file(storageKey).delete({ ignoreNotFound: true });
    } catch (err) {
      this.logger.warn(`Failed to delete ${storageKey}: ${(err as Error).message}`);
    }
  }

  async objectExists(storageKey: string): Promise<boolean> {
    const [exists] = await this.bucket.file(storageKey).exists();
    return exists;
  }

  async getObject(storageKey: string): Promise<ObjectData> {
    const file = this.bucket.file(storageKey);
    const [body] = await file.download();
    let contentType = 'application/octet-stream';
    try {
      const [meta] = await file.getMetadata();
      if (meta.contentType) contentType = meta.contentType;
    } catch {
      /* metadata is best-effort; body is what matters */
    }
    return { body, contentType };
  }
}
