import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../../modules/analytics/analytics.module';
import { NotificationsModule } from '../../modules/notifications/notifications.module';
import { OcrModule } from '../../modules/ocr/ocr.module';
import { AnalyticsProcessor } from './analytics.processor';
import { NotificationsProcessor } from './notifications.processor';
import { OcrProcessor } from './ocr.processor';

@Module({
  imports: [AnalyticsModule, NotificationsModule, OcrModule],
  providers: [AnalyticsProcessor, NotificationsProcessor, OcrProcessor],
})
export class WorkersModule {}
