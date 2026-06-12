import { Decimal } from '@prisma/client/runtime/library';
import { IAnalyticsRepository } from '../repositories/analytics.repository';
import { RecomputeTopicReportsForStudentUseCase } from './recompute-topic-reports.use-case';

describe('RecomputeTopicReportsForStudentUseCase', () => {
  let repo: jest.Mocked<IAnalyticsRepository>;
  let useCase: RecomputeTopicReportsForStudentUseCase;

  beforeEach(() => {
    repo = {
      upsertQuestionStat: jest.fn(),
      upsertTopicReport: jest.fn(),
      getQuestionStat: jest.fn(),
      computeQuestionAggregate: jest.fn(),
      computeStudentTopicAggregates: jest.fn(),
      getExamSummary: jest.fn(),
      getExamQuestionStats: jest.fn(),
      getStudentSummary: jest.fn(),
      getWeakTopics: jest.fn(),
      getTopicReports: jest.fn(),
    };
    useCase = new RecomputeTopicReportsForStudentUseCase(repo);
  });

  it('marks a topic as weak when score percent < 60', async () => {
    repo.computeStudentTopicAggregates.mockResolvedValue([
      { subject: 'Math', topic: 'Geometry', total: 10, correct: 4 },
    ]);
    await useCase.execute({ tenantId: 't', studentId: 's' });
    expect(repo.upsertTopicReport).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Math',
        topic: 'Geometry',
        isWeak: true,
        scorePercent: new Decimal('40.00'),
      }),
    );
  });

  it('does not mark weak when ≥ 60%', async () => {
    repo.computeStudentTopicAggregates.mockResolvedValue([
      { subject: 'Math', topic: 'Algebra', total: 10, correct: 8 },
    ]);
    await useCase.execute({ tenantId: 't', studentId: 's' });
    expect(repo.upsertTopicReport).toHaveBeenCalledWith(expect.objectContaining({ isWeak: false }));
  });
});
