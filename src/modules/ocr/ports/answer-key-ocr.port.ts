import { Injectable } from '@nestjs/common';
import type { AnswerKeyOcrResult } from '../services/answer-key-ocr';

/**
 * Seam for turning an uploaded answer-key image/PDF into text. Kept behind an
 * interface so ImportAnswerKeyUseCase stays unit-testable without a heavy OCR
 * engine, and so the engine choice can change without touching the use-case.
 *
 * The production implementation is the dedicated, ISOLATED `AnswerKeyOcrService`
 * (services/answer-key-ocr.ts) — separate from the question-paper pipeline.
 * `EngineAnswerKeyOcr` below is the legacy fallback (kept for rollback).
 */
export const ANSWER_KEY_OCR = Symbol('ANSWER_KEY_OCR');

export interface IAnswerKeyOcr {
  /** Recognize answer-key text, keeping only answer-key pages, with page metadata. */
  extractAnswerKey(bytes: Buffer, contentType: string): Promise<AnswerKeyOcrResult>;
  /** Convenience: just the answer-key text. */
  extractText(bytes: Buffer, contentType: string): Promise<string>;
}

/**
 * LEGACY fallback (rollback path): runs the shared question OCR engine in TEXT
 * mode and concatenates draft text. Retained ONLY so the answer-key flow can be
 * reverted via env flag; the default is the dedicated AnswerKeyOcrService.
 *
 * NOTE: this path does NOT separate answer-key pages from solution pages — it is
 * the behaviour the new service replaces. Page metadata is therefore empty.
 */
@Injectable()
export class EngineAnswerKeyOcr implements IAnswerKeyOcr {
  async extractText(bytes: Buffer, contentType: string): Promise<string> {
    const { extractDrafts } = await import('../../../shared/ocr-engine/ocr-engine');
    const result = await extractDrafts(bytes, contentType, {});
    return result.drafts
      .map((d) => d.text)
      .filter((t) => t && t.trim().length > 0)
      .join('\n');
  }

  async extractAnswerKey(bytes: Buffer, contentType: string): Promise<AnswerKeyOcrResult> {
    const text = await this.extractText(bytes, contentType);
    return { text, pageTexts: [text], pagesUsed: [], pagesIgnored: [] };
  }
}
