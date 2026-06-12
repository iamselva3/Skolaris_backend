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

export interface SubjectPerformanceRow {
  subject: string;
  scorePercent: number;
  attemptsCount: number;
  correctCount: number;
  topicsCount: number;
  weakCount: number;
}

@Injectable()
export class GetSubjectPerformanceUseCase {
  constructor(@Inject(ANALYTICS_REPOSITORY) private readonly repo: IAnalyticsRepository) {}
  async execute(input: { tenantId: string; studentId: string }): Promise<SubjectPerformanceRow[]> {
    const topics = await this.repo.getTopicReports(input.tenantId, input.studentId);
    const bySubject = new Map<string, SubjectPerformanceRow>();
    for (const t of topics) {
      const row = bySubject.get(t.subject) ?? {
        subject: t.subject,
        scorePercent: 0,
        attemptsCount: 0,
        correctCount: 0,
        topicsCount: 0,
        weakCount: 0,
      };
      row.attemptsCount += t.attemptsCount;
      row.correctCount += t.correctCount;
      row.topicsCount += 1;
      if (t.isWeak) row.weakCount += 1;
      bySubject.set(t.subject, row);
    }
    // Subject accuracy = correct/attempts across all its topics (attempt-weighted),
    // so a subject with many easy attempts isn't masked by averaging topic percents.
    return Array.from(bySubject.values())
      .map((r) => ({
        ...r,
        scorePercent: r.attemptsCount > 0 ? (r.correctCount / r.attemptsCount) * 100 : 0,
      }))
      .sort((a, b) => a.scorePercent - b.scorePercent);
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
