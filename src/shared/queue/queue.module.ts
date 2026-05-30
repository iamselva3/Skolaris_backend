import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { queueConfig } from '../config/queue.config';
import { AnalyticsQueueService } from './analytics-queue.service';
import { NotificationsQueueService } from './notifications-queue.service';
import { OcrHandwritingQueueService } from './ocr-handwriting-queue.service';
import { OcrQueueService } from './ocr-queue.service';

@Global()
@Module({
  imports: [ConfigModule.forFeature(queueConfig)],
  providers: [
    OcrQueueService,
    OcrHandwritingQueueService,
    AnalyticsQueueService,
    NotificationsQueueService,
  ],
  exports: [
    OcrQueueService,
    OcrHandwritingQueueService,
    AnalyticsQueueService,
    NotificationsQueueService,
  ],
})
export class QueueModule {}
