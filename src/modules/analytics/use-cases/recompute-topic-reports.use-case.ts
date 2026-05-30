import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import {
  ANALYTICS_REPOSITORY,
  IAnalyticsRepository,
} from '../repositories/analytics.repository';

const WEAK_THRESHOLD = 60; // percent

@Injectable()
export class RecomputeTopicReportsForStudentUseCase {
  constructor(
    @Inject(ANALYTICS_REPOSITORY) private readonly repo: IAnalyticsRepository,
  ) {}

  async execute(input: { tenantId: string; studentId: string }): Promise<number> {
    const aggregates = await this.repo.computeStudentTopicAggregates(
      input.tenantId,
      input.studentId,
    );
    for (const a of aggregates) {
      const pct = a.total === 0 ? 0 : (a.correct / a.total) * 100;
      await this.repo.upsertTopicReport({
        tenantId: input.tenantId,
        studentId: input.studentId,
        subject: a.subject,
        topic: a.topic,
        attemptsCount: a.total,
        correctCount: a.correct,
        scorePercent: new Decimal(pct.toFixed(2)),
        isWeak: pct < WEAK_THRESHOLD,
      });
    }
    return aggregates.length;
  }
}
