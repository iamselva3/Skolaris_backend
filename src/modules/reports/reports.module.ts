import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { ReportsController } from './controllers/reports.controller';
import { PrismaReportsRepository } from './repositories/prisma-reports.repository';
import { REPORTS_REPOSITORY } from './repositories/reports.repository';
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
  ],
})
export class ReportsModule {}
