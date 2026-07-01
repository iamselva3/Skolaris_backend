import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { ReportsController } from './controllers/reports.controller';
import { PrismaReportsRepository } from './repositories/prisma-reports.repository';
import { REPORTS_REPOSITORY } from './repositories/reports.repository';
import { EXAM_ANALYTICS_REPOSITORY } from './repositories/exam-analytics.repository';
import { PrismaExamAnalyticsRepository } from './repositories/prisma-exam-analytics.repository';
import { ExamAnalyticsUseCases } from './use-cases/exam-analytics.use-cases';
import {
  GetClassReportsUseCase,
  GetExamReportDetailUseCase,
  GetExamReportsUseCase,
  GetQuestionReportsUseCase,
  GetReportsOverviewUseCase,
  GetStudentReportDetailUseCase,
  GetStudentReportsUseCase,
  GetTopicReportsUseCase,
  GetWeakTopicReportUseCase,
} from './use-cases/report.use-cases';

@Module({
  imports: [AnalyticsModule],
  controllers: [ReportsController],
  providers: [
    { provide: REPORTS_REPOSITORY, useClass: PrismaReportsRepository },
    GetReportsOverviewUseCase,
    GetExamReportsUseCase,
    GetExamReportDetailUseCase,
    GetStudentReportsUseCase,
    GetStudentReportDetailUseCase,
    GetTopicReportsUseCase,
    GetWeakTopicReportUseCase,
    GetQuestionReportsUseCase,
    GetClassReportsUseCase,
    { provide: EXAM_ANALYTICS_REPOSITORY, useClass: PrismaExamAnalyticsRepository },
    ExamAnalyticsUseCases,
  ],
})
export class ReportsModule {}
