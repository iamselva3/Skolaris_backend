import { registerAs } from '@nestjs/config';

export type StorageProvider = 'gcs' | 's3';

export interface StorageConfig {
  provider: StorageProvider;
  uploadMaxBytes: number;
  uploadUrlTtlSeconds: number;
  gcs: {
    bucket: string;
    apiEndpoint: string | null;
    projectId: string | null;
    publicHost: string | null;
    serviceAccountJsonPath: string | null;
  };
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
  const provider = (process.env.STORAGE_PROVIDER ?? 'gcs').toLowerCase() as StorageProvider;
  if (provider !== 'gcs' && provider !== 's3') {
    throw new Error(`Invalid STORAGE_PROVIDER: ${provider}`);
  }

  const cfg: StorageConfig = {
    provider,
    uploadMaxBytes: Number(process.env.UPLOAD_MAX_BYTES ?? 25 * 1024 * 1024),
    uploadUrlTtlSeconds: Number(process.env.UPLOAD_URL_TTL_SECONDS ?? 900),
    gcs: {
      bucket: process.env.GCS_BUCKET ?? '',
      apiEndpoint: process.env.GCS_API_ENDPOINT || null,
      projectId: process.env.GCS_PROJECT_ID || null,
      publicHost: process.env.GCS_PUBLIC_HOST || null,
      serviceAccountJsonPath: process.env.GCS_SERVICE_ACCOUNT_JSON || null,
    },
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

  if (provider === 'gcs') {
    required('GCS_BUCKET', cfg.gcs.bucket);
  } else {
    required('AWS_S3_BUCKET', cfg.s3.bucket);
    required('AWS_REGION', cfg.s3.region);
  }
  return cfg;
});
