import { Inject, Injectable } from '@nestjs/common';
import {
  GetExamQuestionStatsUseCase,
  GetExamSummaryUseCase,
  GetStudentSummaryUseCase,
  GetWeakTopicsForStudentUseCase,
} from '../../analytics/use-cases/report-query.use-cases';
import {
  IReportsRepository,
  REPORTS_REPOSITORY,
  ReportFilters,
} from '../repositories/reports.repository';

@Injectable()
export class GetReportsOverviewUseCase {
  constructor(@Inject(REPORTS_REPOSITORY) private readonly repo: IReportsRepository) {}
  execute(input: { tenantId: string; createdBy?: string }) {
    return this.repo.getOverview(input.tenantId, input.createdBy);
  }
}

@Injectable()
export class GetExamReportsUseCase {
  constructor(@Inject(REPORTS_REPOSITORY) private readonly repo: IReportsRepository) {}
  execute(input: { tenantId: string; createdBy?: string; filters: ReportFilters }) {
    return this.repo.listExamReports(input.tenantId, input.createdBy, input.filters);
  }
}

@Injectable()
export class GetExamReportDetailUseCase {
  constructor(
    @Inject(REPORTS_REPOSITORY) private readonly repo: IReportsRepository,
    private readonly examSummaryUC: GetExamSummaryUseCase,
    private readonly examQuestionStatsUC: GetExamQuestionStatsUseCase,
  ) {}

  async execute(input: { tenantId: string; examId: string }) {
    const { tenantId, examId } = input;
    const [header, summary, questionStats] = await Promise.all([
      this.repo.getExamHeader(tenantId, examId),
      this.examSummaryUC.execute({ tenantId, examId }),
      this.examQuestionStatsUC.execute({ tenantId, examId }),
    ]);

    const meta = await this.repo.getQuestionMeta(
      tenantId,
      questionStats.map((q) => q.questionId),
    );

    const questions = questionStats.map((q) => {
      const m = meta.get(q.questionId);
      return {
        examQuestionId: q.examQuestionId,
        questionId: q.questionId,
        stem: m?.stem ?? '',
        type: m?.type ?? null,
        difficulty: m?.difficulty ?? null,
        subject: m?.subject ?? null,
        topic: m?.topic ?? null,
        totalAnswered: q.totalAnswered,
        correctCount: q.correctCount,
        correctPercent:
          q.totalAnswered === 0 ? 0 : Math.round((q.correctCount / q.totalAnswered) * 1000) / 10,
        avgTimeSeconds: Math.round(q.avgTimeSeconds * 10) / 10,
        flag: q.flag,
      };
    });

    return { header, summary, questions };
  }
}

@Injectable()
export class GetStudentReportsUseCase {
  constructor(@Inject(REPORTS_REPOSITORY) private readonly repo: IReportsRepository) {}
  execute(input: { tenantId: string; filters: ReportFilters }) {
    return this.repo.listStudentReports(input.tenantId, input.filters);
  }
}

@Injectable()
export class GetStudentReportDetailUseCase {
  constructor(
    @Inject(REPORTS_REPOSITORY) private readonly repo: IReportsRepository,
    private readonly studentSummaryUC: GetStudentSummaryUseCase,
    private readonly weakTopicsUC: GetWeakTopicsForStudentUseCase,
  ) {}

  async execute(input: { tenantId: string; studentId: string }) {
    const { tenantId, studentId } = input;
    const [detail, summary, weak] = await Promise.all([
      this.repo.getStudentDetail(tenantId, studentId),
      this.studentSummaryUC.execute({ tenantId, studentId }),
      this.weakTopicsUC.execute({ tenantId, studentId }),
    ]);

    return {
      ...detail,
      summary,
      weakTopics: weak.map((w) => ({
        subject: w.subject,
        topic: w.topic,
        scorePercent: Math.round(Number(w.scorePercent) * 10) / 10,
        attemptsCount: w.attemptsCount,
        correctCount: w.correctCount,
      })),
    };
  }
}

@Injectable()
export class GetTopicReportsUseCase {
  constructor(@Inject(REPORTS_REPOSITORY) private readonly repo: IReportsRepository) {}
  execute(input: { tenantId: string; filters: ReportFilters }) {
    return this.repo.listTopicReports(input.tenantId, input.filters, false);
  }
}

@Injectable()
export class GetWeakTopicReportUseCase {
  constructor(@Inject(REPORTS_REPOSITORY) private readonly repo: IReportsRepository) {}
  execute(input: { tenantId: string; filters: ReportFilters }) {
    return this.repo.listTopicReports(input.tenantId, input.filters, true);
  }
}

@Injectable()
export class GetQuestionReportsUseCase {
  constructor(@Inject(REPORTS_REPOSITORY) private readonly repo: IReportsRepository) {}
  execute(input: { tenantId: string; createdBy?: string; filters: ReportFilters }) {
    return this.repo.listQuestionReports(input.tenantId, input.createdBy, input.filters);
  }
}

@Injectable()
export class GetClassReportsUseCase {
  constructor(@Inject(REPORTS_REPOSITORY) private readonly repo: IReportsRepository) {}
  execute(input: { tenantId: string; filters: ReportFilters }) {
    return this.repo.listClassReports(input.tenantId, input.filters);
  }
}
