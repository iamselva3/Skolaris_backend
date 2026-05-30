import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import {
  ANALYTICS_REPOSITORY,
  IAnalyticsRepository,
} from '../repositories/analytics.repository';

@Injectable()
export class RecomputeQuestionStatsUseCase {
  constructor(
    @Inject(ANALYTICS_REPOSITORY) private readonly repo: IAnalyticsRepository,
  ) {}

  async execute(input: { tenantId: string; questionId: string }): Promise<void> {
    const agg = await this.repo.computeQuestionAggregate(input.tenantId, input.questionId);
    const difficulty =
      agg.total === 0 ? null : new Decimal(1).minus(new Decimal(agg.correct).div(agg.total));
    await this.repo.upsertQuestionStat({
      tenantId: input.tenantId,
      questionId: input.questionId,
      totalAttempts: agg.total,
      correctAttempts: agg.correct,
      avgTimeSeconds: new Decimal(agg.avgTime.toFixed(2)),
      difficultyScore: difficulty,
    });
  }
}
