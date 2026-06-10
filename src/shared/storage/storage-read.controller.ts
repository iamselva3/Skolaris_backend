import { Controller, Get, Inject, Logger, Req, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Request, Response } from 'express';
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

  // Wildcard after `/o/` so object keys WITH slashes work regardless of whether
  // the path is percent-encoded ("a%2Fb", one segment) or arrives decoded
  // ("a/b", many segments). A single-segment `:key` param 404s the latter before
  // getObject ever runs — which silently broke ocr-figures/ snapshot reads.
  @Public()
  @Get(['storage/v1/b/:bucket/o/*', 'download/storage/v1/b/:bucket/o/*'])
  async read(@Req() req: Request, @Res() res: Response): Promise<void> {
    const raw = (req.params as Record<string, string>)['0'] ?? '';
    let key = raw;
    try {
      // Decode percent-escapes when present; a no-op for an already-decoded path.
      key = raw.includes('%') ? decodeURIComponent(raw) : raw;
    } catch {
      /* malformed escape — fall back to the raw value */
    }
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
