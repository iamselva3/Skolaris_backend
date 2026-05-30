import { Module } from '@nestjs/common';
import { AttemptsModule } from '../attempts/attempts.module';
import { AnalyticsController } from './controllers/analytics.controller';
import { MeReportsController } from './controllers/me-reports.controller';
import { ANALYTICS_REPOSITORY } from './repositories/analytics.repository';
import { PrismaAnalyticsRepository } from './repositories/prisma-analytics.repository';
import { RecomputeQuestionStatsUseCase } from './use-cases/recompute-question-stats.use-case';
import { RecomputeTopicReportsForStudentUseCase } from './use-cases/recompute-topic-reports.use-case';
import {
  GetExamQuestionStatsUseCase,
  GetExamSummaryUseCase,
  GetQuestionStatsUseCase,
  GetStudentSummaryUseCase,
  GetWeakTopicsForStudentUseCase,
} from './use-cases/report-query.use-cases';

@Module({
  imports: [AttemptsModule],
  controllers: [AnalyticsController, MeReportsController],
  providers: [
    { provide: ANALYTICS_REPOSITORY, useClass: PrismaAnalyticsRepository },
    RecomputeQuestionStatsUseCase,
    RecomputeTopicReportsForStudentUseCase,
    GetExamSummaryUseCase,
    GetExamQuestionStatsUseCase,
    GetStudentSummaryUseCase,
    GetWeakTopicsForStudentUseCase,
    GetQuestionStatsUseCase,
  ],
  exports: [
    ANALYTICS_REPOSITORY,
    RecomputeQuestionStatsUseCase,
    RecomputeTopicReportsForStudentUseCase,
    GetExamSummaryUseCase,
    GetExamQuestionStatsUseCase,
    GetStudentSummaryUseCase,
    GetWeakTopicsForStudentUseCase,
  ],
})
export class AnalyticsModule {}
