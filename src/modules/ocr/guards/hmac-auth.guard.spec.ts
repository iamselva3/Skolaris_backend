import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { ConfigType } from '@nestjs/config';
import { ocrConfig } from '../../../shared/config/ocr.config';
import { defaultRoutingConfig } from '../../../shared/ocr-engine/routing';
import { HmacAuthGuard } from './hmac-auth.guard';

const SECRET = 'a-test-secret-that-is-long-enough';
const cfg = {
  callbackSecret: SECRET,
  serviceBaseUrl: null,
  handwritingEnabled: false,
  handwritingServiceUrl: null,
  handwritingTimeoutMs: 120_000,
  handwritingConfidenceThreshold: 0.7,
  routing: defaultRoutingConfig(),
} satisfies ConfigType<typeof ocrConfig>;

const ctxFor = (rawBody: Buffer | undefined, signature: string | undefined): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        rawBody,
        headers: { 'x-ocr-signature': signature },
      }),
    }),
  }) as unknown as ExecutionContext;

describe('HmacAuthGuard', () => {
  const guard = new HmacAuthGuard(cfg);
  const body = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');
  const validSig = createHmac('sha256', SECRET).update(body).digest('hex');

  it('accepts a request with a valid signature', () => {
    expect(guard.canActivate(ctxFor(body, validSig))).toBe(true);
  });

  it('rejects a request with no signature', () => {
    expect(() => guard.canActivate(ctxFor(body, undefined))).toThrow(UnauthorizedException);
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from(JSON.stringify({ hello: 'world!' }), 'utf8');
    expect(() => guard.canActivate(ctxFor(tampered, validSig))).toThrow(UnauthorizedException);
  });

  it('rejects a different secret signature', () => {
    const wrong = createHmac('sha256', 'other-secret').update(body).digest('hex');
    expect(() => guard.canActivate(ctxFor(body, wrong))).toThrow(UnauthorizedException);
  });

  it('rejects when raw body is missing', () => {
    expect(() => guard.canActivate(ctxFor(undefined, validSig))).toThrow(UnauthorizedException);
  });
});
