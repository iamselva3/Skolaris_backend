import { ModuleRef } from '@nestjs/core';
import { InlineOcrDispatcher } from './inline-ocr-dispatcher.service';
import { OcrJobRunner } from '../workers/ocr-job-runner.service';
import { HandleOcrCallbackUseCase } from '../../modules/ocr/use-cases/handle-ocr-callback.use-case';
import { OCR_JOB_REPOSITORY } from '../../modules/ocr/repositories/ocr-job.repository';
import type { OcrExtractJob } from './ocr-queue.service';

const job = (id: string): OcrExtractJob => ({ ocrJobId: id, tenantId: 't', uploadId: `u-${id}`, storageKey: `k-${id}` });
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('InlineOcrDispatcher — startup-delay / deadlock guards', () => {
  let runner: { run: jest.Mock };
  let jobs: { updateProgress: jest.Mock; markPaused: jest.Mock };
  let callback: { execute: jest.Mock };
  let dispatcher: InlineOcrDispatcher;

  beforeEach(() => {
    process.env.OCR_INLINE_JOB_TIMEOUT_MS = '50'; // tiny ceiling for the test
    runner = { run: jest.fn().mockResolvedValue(undefined) };
    jobs = {
      updateProgress: jest.fn().mockResolvedValue(undefined),
      markPaused: jest.fn().mockResolvedValue(undefined),
    };
    callback = { execute: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = {
      get: (token: unknown) =>
        token === OcrJobRunner ? runner : token === OCR_JOB_REPOSITORY ? jobs : token === HandleOcrCallbackUseCase ? callback : undefined,
    } as unknown as ModuleRef;
    dispatcher = new InlineOcrDispatcher(moduleRef);
  });
  afterEach(() => { delete process.env.OCR_INLINE_JOB_TIMEOUT_MS; });

  it('P0: a hung job is timed out, PAUSED (resumable), and the queue ADVANCES to the next job', async () => {
    runner.run
      .mockImplementationOnce(() => new Promise<void>(() => undefined)) // job A: never settles (the deadlock)
      .mockResolvedValueOnce(undefined); // job B: normal

    await dispatcher.enqueue(job('A'));
    await dispatcher.enqueue(job('B'));
    await tick(200); // > timeout, let A time out and B run

    // Resumable OCR (P0, default ON): the timeout PAUSES A (checkpoints kept,
    // upload stays PROCESSING) instead of failing it — recovery resumes it later.
    expect(jobs.markPaused).toHaveBeenCalledTimes(1);
    expect(jobs.markPaused.mock.calls[0][0]).toBe('A');
    expect(jobs.markPaused.mock.calls[0][1]).toMatch(/timed out/i);
    // The upload is NOT failed via the canonical callback.
    expect(callback.execute).not.toHaveBeenCalled();
    // The queue advanced: B actually ran despite A hanging forever.
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(runner.run.mock.calls[1][0]).toMatchObject({ ocrJobId: 'B' });
  });

  it('P1: a job waiting behind an in-flight one publishes QUEUED + queuePosition', async () => {
    runner.run.mockImplementationOnce(() => new Promise<void>(() => undefined)); // A occupies the tail

    await dispatcher.enqueue(job('A')); // position 0 → runs immediately, no QUEUED
    await dispatcher.enqueue(job('B')); // position 1 → waiting
    await tick(10);

    expect(jobs.updateProgress).toHaveBeenCalledWith('B', { stage: 'QUEUED', queuePosition: 1 });
    // the first (immediately-running) job is never marked QUEUED
    expect(jobs.updateProgress).not.toHaveBeenCalledWith('A', expect.objectContaining({ stage: 'QUEUED' }));
  });

  it('enqueue returns immediately without awaiting the run (fire-and-forget contract preserved)', async () => {
    runner.run.mockImplementationOnce(() => new Promise<void>(() => undefined));
    const id = await dispatcher.enqueue(job('A'));
    expect(id).toBe('A');
    expect(runner.run).toHaveBeenCalledTimes(1); // scheduled, not awaited
  });
});
