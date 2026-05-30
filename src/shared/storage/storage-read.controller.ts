import { Controller, Get, Inject, Logger, Param, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { Public } from '../../modules/auth/decorators/public.decorator';
import { JwtAuthGuard } from '../../modules/auth/guards/jwt-auth.guard';
import { IObjectStorage, OBJECT_STORAGE } from './object-storage.interface';

/**
 * Object READ proxy for the private R2/S3 bucket. Serves the EXACT URL shapes
 * the frontend and the standalone OCR worker already build (kept for backward
 * compatibility — the path shape is historical, not provider-specific):
 *   FE  : GET {host}/storage/v1/b/<bucket>/o/<urlencoded-key>?alt=media
 *   OCR : GET {host}/download/storage/v1/b/<bucket>/o/<urlencoded-key>?alt=media
 * and streams the bytes from the active S3/R2 adapter via getObject. The :bucket
 * segment is cosmetic; objects are keyed by :key alone.
 *
 * Point VITE_GCS_PUBLIC_HOST (FE) and STORAGE_READ_BASE_URL (standalone OCR
 * worker) at this backend's "/api" base and a private R2 bucket renders
 * transparently. The in-process OCR consumer bypasses this proxy entirely and
 * reads bytes directly via the injected adapter.
 *
 * @Public (image tags / server fetch can't carry a JWT) — matching the existing
 * unauthenticated read posture. @SkipThrottle so image-heavy pages aren't
 * rate-limited.
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
