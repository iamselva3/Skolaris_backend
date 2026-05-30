import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../../modules/analytics/analytics.module';
import { NotificationsModule } from '../../modules/notifications/notifications.module';
import { OcrModule } from '../../modules/ocr/ocr.module';
import { AnalyticsProcessor } from './analytics.processor';
import { NotificationsProcessor } from './notifications.processor';
import { OcrProcessor } from './ocr.processor';
import { OcrJobRunner } from './ocr-job-runner.service';
import { AnalyticsJobRunner } from './analytics-job-runner.service';

@Module({
  imports: [AnalyticsModule, NotificationsModule, OcrModule],
  // The *JobRunner providers are the shared job bodies used by BOTH the BullMQ
  // workers and the inline dispatchers (resolved via ModuleRef, non-strict).
  providers: [
    AnalyticsProcessor,
    NotificationsProcessor,
    OcrProcessor,
    OcrJobRunner,
    AnalyticsJobRunner,
  ],
  exports: [OcrJobRunner, AnalyticsJobRunner],
})
export class WorkersModule {}
