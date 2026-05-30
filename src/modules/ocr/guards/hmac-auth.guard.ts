import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { ocrConfig } from '../../../shared/config/ocr.config';

export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

const SIGNATURE_HEADER = 'x-ocr-signature';

@Injectable()
export class HmacAuthGuard implements CanActivate {
  private readonly logger = new Logger(HmacAuthGuard.name);

  constructor(@Inject(ocrConfig.KEY) private readonly cfg: ConfigType<typeof ocrConfig>) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RawBodyRequest>();
    const provided = req.headers[SIGNATURE_HEADER];
    if (typeof provided !== 'string' || provided.length === 0) {
      throw new UnauthorizedException('Missing X-OCR-Signature header');
    }
    if (!req.rawBody) {
      this.logger.error('rawBody not captured on OCR callback request');
      throw new UnauthorizedException('Cannot verify signature');
    }
    const expected = createHmac('sha256', this.cfg.callbackSecret)
      .update(req.rawBody)
      .digest('hex');

    const provBuf = Buffer.from(provided, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (provBuf.length !== expBuf.length || !timingSafeEqual(provBuf, expBuf)) {
      throw new UnauthorizedException('Invalid X-OCR-Signature');
    }
    return true;
  }
}
