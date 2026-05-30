import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../../modules/analytics/analytics.module';
import { NotificationsModule } from '../../modules/notifications/notifications.module';
import { OcrModule } from '../../modules/ocr/ocr.module';
import { AnalyticsProcessor } from './analytics.processor';
import { NotificationsProcessor } from './notifications.processor';
import { OcrProcessor } from './ocr.processor';
import { OcrJobRunner } from './ocr-job-runner.service';

@Module({
  imports: [AnalyticsModule, NotificationsModule, OcrModule],
  // OcrJobRunner is the shared OCR job body used by BOTH the BullMQ worker
  // (OcrProcessor) and InlineOcrDispatcher (resolved via ModuleRef, non-strict).
  providers: [AnalyticsProcessor, NotificationsProcessor, OcrProcessor, OcrJobRunner],
  exports: [OcrJobRunner],
})
export class WorkersModule {}
