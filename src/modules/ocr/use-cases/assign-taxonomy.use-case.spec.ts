import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssignTaxonomyUseCase } from './assign-taxonomy.use-case';
import { IOcrDraftRepository } from '../repositories/ocr-draft.repository';
import { IOcrJobRepository } from '../repositories/ocr-job.repository';
import { Difficulty } from '../../questions/models/question-type.enum';

describe('AssignTaxonomyUseCase', () => {
  let drafts: jest.Mocked<IOcrDraftRepository>;
  let ocrJobs: jest.Mocked<IOcrJobRepository>;
  let useCase: AssignTaxonomyUseCase;

  beforeEach(() => {
    drafts = {
      setTaxonomy: jest.fn().mockResolvedValue(12),
    } as unknown as jest.Mocked<IOcrDraftRepository>;
    ocrJobs = {
      findById: jest.fn().mockResolvedValue({ id: 'job1' }),
    } as unknown as jest.Mocked<IOcrJobRepository>;
    useCase = new AssignTaxonomyUseCase(drafts, ocrJobs);
  });

  it('applies to ALL drafts when no draftIds given', async () => {
    const r = await useCase.execute({
      tenantId: 't1',
      ocrJobId: 'job1',
      subjectId: 's1',
      chapterId: 'c1',
      difficulty: Difficulty.MEDIUM,
    });
    expect(r).toEqual({ updated: 12, appliedToAll: true });
    expect(drafts.setTaxonomy).toHaveBeenCalledWith('t1', 'job1', null, {
      subjectId: 's1',
      chapterId: 'c1',
      difficulty: Difficulty.MEDIUM,
    });
  });

  it('applies to selected drafts when draftIds given', async () => {
    await useCase.execute({
      tenantId: 't1',
      ocrJobId: 'job1',
      draftIds: ['d1', 'd2'],
      programId: 'p1',
    });
    expect(drafts.setTaxonomy).toHaveBeenCalledWith('t1', 'job1', ['d1', 'd2'], {
      programId: 'p1',
    });
  });

  it('treats an empty draftIds array as apply-to-all', async () => {
    const r = await useCase.execute({
      tenantId: 't1',
      ocrJobId: 'job1',
      draftIds: [],
      topicId: 'tp1',
    });
    expect(r.appliedToAll).toBe(true);
    expect(drafts.setTaxonomy).toHaveBeenCalledWith('t1', 'job1', null, { topicId: 'tp1' });
  });

  it('rejects when no taxonomy field is provided', async () => {
    await expect(
      useCase.execute({ tenantId: 't1', ocrJobId: 'job1', draftIds: ['d1'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(drafts.setTaxonomy).not.toHaveBeenCalled();
  });

  it('404s for an unknown job', async () => {
    ocrJobs.findById.mockResolvedValue(null);
    await expect(
      useCase.execute({ tenantId: 't1', ocrJobId: 'nope', subjectId: 's1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
