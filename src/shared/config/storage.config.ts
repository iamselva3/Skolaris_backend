import { registerAs } from '@nestjs/config';

/**
 * SKOLARIS is S3/R2-only. The provider seam is retained (pinned to 's3') so a
 * future S3-compatible backend can be added without re-plumbing DI, but the
 * legacy Google Cloud Storage adapter has been removed. Cloudflare R2 is the
 * canonical production backend (S3 adapter + S3_ENDPOINT); AWS S3 and MinIO
 * (dev) use the same adapter.
 */
export type StorageProvider = 's3';

export interface StorageConfig {
  provider: StorageProvider;
  uploadMaxBytes: number;
  uploadUrlTtlSeconds: number;
  /**
   * Base URL of the backend storage read-proxy (StorageReadController), e.g.
   * `https://<api-host>/api`. Used ONLY by the DI-less standalone OCR worker
   * (scripts/ocr-worker.ts) to fetch object bytes over HTTP. The in-process
   * OCR consumer reads bytes directly via the injected adapter and ignores this.
   * null when unset — the standalone worker fails fast with a clear message.
   */
  readBaseUrl: string | null;
  s3: {
    bucket: string;
    region: string;
    accessKeyId: string | null;
    secretAccessKey: string | null;
    /** Custom S3 endpoint. Required for Cloudflare R2 (https://<account>.r2.cloudflarestorage.com) and MinIO. null = real AWS. */
    endpoint: string | null;
    /** Browser/external-reachable endpoint for PRESIGNED upload URLs (e.g. MinIO behind docker). Defaults to endpoint. */
    publicEndpoint: string | null;
    /** Path-style addressing (recommended for R2 + MinIO). */
    forcePathStyle: boolean;
  };
}

const required = (key: string, value: string | undefined): string => {
  if (!value || value.length === 0) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

export const storageConfig = registerAs<StorageConfig>('storage', () => {
  const provider = (process.env.STORAGE_PROVIDER ?? 's3').toLowerCase();
  if (provider !== 's3') {
    throw new Error(
      `Invalid STORAGE_PROVIDER "${provider}": SKOLARIS is S3/R2-only. ` +
        `Set STORAGE_PROVIDER=s3 (or leave it unset) and configure the AWS_*/S3_* vars for Cloudflare R2.`,
    );
  }

  const cfg: StorageConfig = {
    provider: 's3',
    uploadMaxBytes: Number(process.env.UPLOAD_MAX_BYTES ?? 25 * 1024 * 1024),
    uploadUrlTtlSeconds: Number(process.env.UPLOAD_URL_TTL_SECONDS ?? 900),
    readBaseUrl: process.env.STORAGE_READ_BASE_URL || null,
    s3: {
      bucket: process.env.AWS_S3_BUCKET ?? '',
      region: process.env.AWS_REGION ?? '',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || null,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || null,
      endpoint: process.env.S3_ENDPOINT || null,
      publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || null,
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
    },
  };

  required('AWS_S3_BUCKET', cfg.s3.bucket);
  required('AWS_REGION', cfg.s3.region);
  return cfg;
});
