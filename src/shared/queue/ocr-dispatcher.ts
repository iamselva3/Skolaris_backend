import type { OcrExtractJob } from './ocr-queue.service';

/**
 * DI token for the OCR dispatch seam. Consumers (CompleteUploadUseCase) inject
 * IOcrDispatcher via this token instead of a concrete queue service, so the
 * delivery mechanism — BullMQ/Redis vs. in-process — is an env-selected
 * implementation detail. Selected by QUEUE_DRIVER in queue.module.ts.
 */
export const OCR_DISPATCHER = Symbol('OCR_DISPATCHER');

/**
 * The single behaviour every OCR backend must provide: accept an extraction job
 * and return promptly (the job runs asynchronously). The HTTP request that
 * triggers it is NEVER blocked by OCR work.
 *
 * Implementations:
 *   - OcrQueueService     (QUEUE_DRIVER=redis)  — adds the job to BullMQ.
 *   - InlineOcrDispatcher (QUEUE_DRIVER=inline) — runs it in-process, fire-and-forget.
 */
export interface IOcrDispatcher {
  /** Schedule extraction; resolves with the job id without awaiting OCR. */
  enqueue(job: OcrExtractJob): Promise<string>;
}
