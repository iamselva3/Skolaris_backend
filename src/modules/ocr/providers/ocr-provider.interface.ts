import { QuestionType } from '../../questions/models/question-type.enum';
import type { RoutingDecision, RoutingSignal } from '../../../shared/ocr-engine/routing';

export const OCR_PROVIDER = Symbol('OCR_PROVIDER');

export interface ProviderDraftOption {
  label: string;
  isCorrect?: boolean;
}

export interface ProviderDraft {
  position: number;
  text: string;
  detectedType?: QuestionType | null;
  options?: ProviderDraftOption[] | null;
  confidence?: number | null;
}

export interface ProviderExtractionResult {
  providerUsed: string;
  overallConfidence: number | null;
  drafts: ProviderDraft[];
  /** Raw provider response, persisted on the OcrJob for auditing. */
  raw: unknown;
}

/**
 * Backend-side abstraction over the OCR microservice. In Phase 2 the
 * actual OCR happens in a separate FastAPI process; the backend uses
 * this interface only to NORMALIZE callback payloads, so different
 * providers (PaddleOCR primary, Google Vision fallback) can be plugged
 * in without changing the rest of the pipeline.
 *
 * Concrete provider rule: when PaddleOCR confidence is below a
 * threshold or extraction fails, the OCR microservice itself should
 * re-run with Google Vision and report `providerUsed = "vision"` in
 * the callback. The backend trusts that field.
 */
export interface IOcrProvider {
  /**
   * Decides whether the OCR result is high-confidence enough to mark
   * the upload READY_FOR_REVIEW, or low-confidence enough that the UI
   * should surface a "low confidence — please review carefully" hint.
   */
  isHighConfidence(overall: number | null): boolean;

  /**
   * OPTIONAL (handwriting fallback). Given the routing signal computed from a
   * first-pass OCR, decide whether the job should be re-routed to the Python
   * handwriting service. Default behaviour (no implementation) is "never route".
   * Routing today is driven by the DI-free engine seam (resolve-drafts.ts) so
   * both the in-process and standalone consumers stay in lockstep; this hook
   * exists for DI consumers that want to override the decision.
   */
  shouldRouteToFallback?(signal: RoutingSignal): RoutingDecision;
}
