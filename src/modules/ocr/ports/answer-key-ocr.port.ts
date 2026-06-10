import { Injectable } from '@nestjs/common';

/**
 * Seam for turning an uploaded answer-key image/PDF into text. Kept behind an
 * interface so ImportAnswerKeyUseCase stays unit-testable without the heavy OCR
 * engine, and so the engine choice can change without touching the use-case.
 */
export const ANSWER_KEY_OCR = Symbol('ANSWER_KEY_OCR');

export interface IAnswerKeyOcr {
  /** Recognize all printed text on an answer-key file. */
  extractText(bytes: Buffer, contentType: string): Promise<string>;
}

/**
 * Default implementation: runs the shared OCR engine in TEXT mode (no putObject
 * hook → screenshot-first is disabled), which is exactly right for a dense
 * printed answer key, then concatenates the recognized draft text.
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
}
