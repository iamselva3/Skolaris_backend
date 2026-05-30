import { registerAs } from '@nestjs/config';
import { routingConfigFromEnv, type RoutingConfig } from '../ocr-engine/routing';

export interface OcrConfig {
  callbackSecret: string;
  serviceBaseUrl: string | null;
  /** Optional Python handwriting fallback (default OFF == today's behaviour). */
  handwritingEnabled: boolean;
  handwritingServiceUrl: string | null;
  handwritingTimeoutMs: number;
  handwritingConfidenceThreshold: number;
  routing: RoutingConfig;
}

export const ocrConfig = registerAs<OcrConfig>('ocr', () => {
  const callbackSecret = process.env.OCR_CALLBACK_SECRET;
  if (!callbackSecret || callbackSecret.length < 16) {
    throw new Error(
      'Missing or weak OCR_CALLBACK_SECRET (must be at least 16 characters)',
    );
  }
  return {
    callbackSecret,
    serviceBaseUrl: process.env.OCR_SERVICE_BASE_URL || null,
    handwritingEnabled: process.env.HANDWRITING_OCR_ENABLED === 'true',
    handwritingServiceUrl: process.env.HANDWRITING_OCR_URL || null,
    handwritingTimeoutMs: Number(process.env.HANDWRITING_OCR_TIMEOUT_MS) || 120_000,
    handwritingConfidenceThreshold: Number(process.env.HANDWRITING_OCR_MIN_CONFIDENCE) || 0.7,
    routing: routingConfigFromEnv(process.env),
  };
});
