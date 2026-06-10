import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TopicReportModel } from '../models/analytics.models';
import { ANALYTICS_REPOSITORY, IAnalyticsRepository } from '../repositories/analytics.repository';

@Injectable()
export class GetExamSummaryUseCase {
  constructor(@Inject(ANALYTICS_REPOSITORY) private readonly repo: IAnalyticsRepository) {}
  execute(input: { tenantId: string; examId: string }) {
    return this.repo.getExamSummary(input.tenantId, input.examId);
  }
}

@Injectable()
export class GetExamQuestionStatsUseCase {
  constructor(@Inject(ANALYTICS_REPOSITORY) private readonly repo: IAnalyticsRepository) {}
  execute(input: { tenantId: string; examId: string }) {
    return this.repo.getExamQuestionStats(input.tenantId, input.examId);
  }
}

@Injectable()
export class GetStudentSummaryUseCase {
  constructor(@Inject(ANALYTICS_REPOSITORY) private readonly repo: IAnalyticsRepository) {}
  execute(input: { tenantId: string; studentId: string }) {
    return this.repo.getStudentSummary(input.tenantId, input.studentId);
  }
}

@Injectable()
export class GetWeakTopicsForStudentUseCase {
  constructor(@Inject(ANALYTICS_REPOSITORY) private readonly repo: IAnalyticsRepository) {}
  execute(input: { tenantId: string; studentId: string }): Promise<TopicReportModel[]> {
    return this.repo.getWeakTopics(input.tenantId, input.studentId);
  }
}

@Injectable()
export class GetQuestionStatsUseCase {
  constructor(@Inject(ANALYTICS_REPOSITORY) private readonly repo: IAnalyticsRepository) {}
  async execute(input: { tenantId: string; questionId: string }) {
    const r = await this.repo.getQuestionStat(input.tenantId, input.questionId);
    if (!r) throw new NotFoundException('No stats yet for this question');
    return r;
  }
}
