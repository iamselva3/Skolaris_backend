import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ImportAnswerKeyUseCase } from './import-answer-key.use-case';
import { IOcrDraftRepository } from '../repositories/ocr-draft.repository';
import { IOcrJobRepository } from '../repositories/ocr-job.repository';
import { IObjectStorage } from '../../../shared/storage/object-storage.interface';
import { IAnswerKeyOcr } from '../ports/answer-key-ocr.port';
import { OcrDraftModel } from '../models/ocr-draft.model';
import { QuestionType } from '../../questions/models/question-type.enum';

const makeDraft = (id: string, text: string, optionCount = 4): OcrDraftModel => {
  const d = new OcrDraftModel(
    id,
    't1',
    'job1',
    0,
    text,
    QuestionType.VISUAL,
    null,
    null,
    'PENDING_REVIEW',
    null,
    new Date(),
    new Date(),
  );
  d.optionCount = optionCount;
  return d;
};

describe('ImportAnswerKeyUseCase', () => {
  let drafts: jest.Mocked<IOcrDraftRepository>;
  let ocrJobs: jest.Mocked<IOcrJobRepository>;
  let storage: jest.Mocked<IObjectStorage>;
  let ocr: jest.Mocked<IAnswerKeyOcr>;
  let useCase: ImportAnswerKeyUseCase;

  beforeEach(() => {
    drafts = {
      bulkCreate: jest.fn(),
      list: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      countByJob: jest.fn(),
      setSuggestedAnswers: jest.fn().mockImplementation(async (_t, items) => items.length),
    } as unknown as jest.Mocked<IOcrDraftRepository>;
    ocrJobs = {
      findById: jest.fn().mockResolvedValue({ id: 'job1' }),
    } as unknown as jest.Mocked<IOcrJobRepository>;
    storage = { getObject: jest.fn() } as unknown as jest.Mocked<IObjectStorage>;
    ocr = {
      extractText: jest.fn(),
      extractAnswerKey: jest.fn(),
    } as unknown as jest.Mocked<IAnswerKeyOcr>;
    useCase = new ImportAnswerKeyUseCase(drafts, ocrJobs, storage, ocr);
  });

  it('maps typed answer-key text onto drafts and persists suggestions', async () => {
    drafts.list.mockResolvedValue({
      data: [makeDraft('d1', '1. Q one'), makeDraft('d2', '2) Q two')],
      total: 2,
    });

    const r = await useCase.execute({ tenantId: 't1', ocrJobId: 'job1', text: '1-A 2-C' });

    expect(r.matched).toBe(2);
    expect(r.keyEntries).toBe(2);
    expect(drafts.setSuggestedAnswers).toHaveBeenCalledWith('t1', [
      { id: 'd1', suggestedAnswer: { source: 'answer-key', raw: 'A', correctIndex: 1 } },
      { id: 'd2', suggestedAnswer: { source: 'answer-key', raw: 'C', correctIndex: 3 } },
    ]);
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it('OCRs the uploaded answer key (isolated service) when only a storageKey is given', async () => {
    storage.getObject.mockResolvedValue({ body: Buffer.from('x'), contentType: 'image/png' });
    ocr.extractAnswerKey.mockResolvedValue({
      text: '1-B',
      pageTexts: ['1-B'],
      pagesUsed: [1],
      pagesIgnored: [],
    });
    drafts.list.mockResolvedValue({ data: [makeDraft('d1', '1. Q one')], total: 1 });

    const r = await useCase.execute({ tenantId: 't1', ocrJobId: 'job1', storageKey: 'keys/a.png' });

    expect(ocr.extractAnswerKey).toHaveBeenCalled();
    expect(r.matched).toBe(1);
    expect(r.report.pagesUsed).toEqual([1]);
  });

  it('preview returns a report WITHOUT writing, including zero/invalid/missing', async () => {
    drafts.list.mockResolvedValue({
      data: [makeDraft('d1', '1. Q one'), makeDraft('d2', '3) Q three')],
      total: 2,
    });

    const { report, willMatch, draftCount } = await useCase.preview({
      tenantId: 't1',
      ocrJobId: 'job1',
      text: '0-A 1-B 3-Z 4-C',
    });

    expect(report.zeroOrNegative).toEqual([0]); // Q0 rejected
    expect(report.entries.map((e) => e.questionNumber)).toEqual([1, 4]); // 3-Z invalid, 0 rejected
    expect(report.invalid).toEqual([{ questionNumber: 3, raw: 'Z', reason: 'Invalid answer value' }]);
    expect(report.missingNumbers).toEqual([2, 3]); // gaps within 1..4
    expect(willMatch).toBe(1); // only Q1 maps to a draft
    expect(draftCount).toBe(2);
    expect(drafts.setSuggestedAnswers).not.toHaveBeenCalled();
  });

  it('reports unmatched key numbers and unmatched drafts', async () => {
    drafts.list.mockResolvedValue({
      data: [makeDraft('d1', '1. Q one'), makeDraft('d2', 'no number')],
      total: 2,
    });
    const r = await useCase.execute({ tenantId: 't1', ocrJobId: 'job1', text: '1-A 9-C' });
    expect(r.unmatchedKeyNumbers).toEqual([9]);
    expect(r.unmatchedDrafts).toBe(1);
  });

  it('rejects when neither text nor storageKey is provided', async () => {
    await expect(useCase.execute({ tenantId: 't1', ocrJobId: 'job1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects when the key has no parseable mappings', async () => {
    drafts.list.mockResolvedValue({ data: [], total: 0 });
    await expect(
      useCase.execute({ tenantId: 't1', ocrJobId: 'job1', text: 'just some prose' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s for an unknown job', async () => {
    ocrJobs.findById.mockResolvedValue(null);
    await expect(
      useCase.execute({ tenantId: 't1', ocrJobId: 'nope', text: '1-A' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
