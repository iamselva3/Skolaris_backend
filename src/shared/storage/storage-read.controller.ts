import { Controller, Get, Inject, Logger, Param, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { Public } from '../../modules/auth/decorators/public.decorator';
import { JwtAuthGuard } from '../../modules/auth/guards/jwt-auth.guard';
import { IObjectStorage, OBJECT_STORAGE } from './object-storage.interface';

/**
 * GCS-compatible object READ proxy. Serves the EXACT URL shapes the frontend
 * and the OCR engine already build:
 *   FE  : GET {host}/storage/v1/b/<bucket>/o/<urlencoded-key>?alt=media
 *   OCR : GET {host}/download/storage/v1/b/<bucket>/o/<urlencoded-key>?alt=media
 * and streams the bytes from whatever provider is active (R2/S3 via getObject).
 *
 * This is the entire reason no frontend/OCR code changes for R2: point
 * VITE_GCS_PUBLIC_HOST (FE) and GCS_API_ENDPOINT (OCR) at this backend ("/api"
 * base) and a private R2 bucket renders transparently. With STORAGE_PROVIDER=gcs
 * those envs keep pointing at fake-gcs/GCS and this proxy is simply unused.
 *
 * @Public (image tags / server fetch can't carry a JWT) — matching the existing
 * unauthenticated read posture (public GCS objects / fake-gcs today). @SkipThrottle
 * so image-heavy pages aren't rate-limited.
 */
@SkipThrottle()
@UseGuards(JwtAuthGuard)
@Controller()
export class StorageReadController {
  private readonly logger = new Logger(StorageReadController.name);

  constructor(@Inject(OBJECT_STORAGE) private readonly storage: IObjectStorage) {}

  @Public()
  @Get(['storage/v1/b/:bucket/o/:key', 'download/storage/v1/b/:bucket/o/:key'])
  async read(@Param('key') key: string, @Res() res: Response): Promise<void> {
    try {
      const { body, contentType } = await this.storage.getObject(key);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(body);
    } catch (err) {
      this.logger.warn(`object read miss for "${key}": ${(err as Error).message}`);
      res.status(404).send('Not found');
    }
  }
}
