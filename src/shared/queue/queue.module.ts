import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { queueConfig } from '../config/queue.config';
import { AnalyticsQueueService } from './analytics-queue.service';
import { NotificationsQueueService } from './notifications-queue.service';
import { OcrHandwritingQueueService } from './ocr-handwriting-queue.service';
import { OcrQueueService } from './ocr-queue.service';
import { InlineOcrDispatcher } from './inline-ocr-dispatcher.service';
import { InlineAnalyticsDispatcher } from './inline-analytics-dispatcher.service';
import { InlineNotificationsDispatcher } from './inline-notifications-dispatcher.service';
import { OCR_DISPATCHER, IOcrDispatcher } from './ocr-dispatcher';
import { ANALYTICS_DISPATCHER, IAnalyticsDispatcher } from './analytics-dispatcher';
import { NOTIFICATIONS_DISPATCHER, INotificationsDispatcher } from './notifications-dispatcher';

/**
 * Each *_DISPATCHER token resolves to the BullMQ producer (QUEUE_DRIVER=redis)
 * or the in-process dispatcher (QUEUE_DRIVER=inline, default). All producers are
 * lazy, so the unused candidate opens no Redis connection — flipping back to
 * 'redis' needs no code change.
 */
const ocrDispatcherProvider = {
  provide: OCR_DISPATCHER,
  inject: [queueConfig.KEY, OcrQueueService, InlineOcrDispatcher],
  useFactory: (
    cfg: ConfigType<typeof queueConfig>,
    redis: OcrQueueService,
    inline: InlineOcrDispatcher,
  ): IOcrDispatcher => (cfg.queueDriver === 'redis' ? redis : inline),
};

const analyticsDispatcherProvider = {
  provide: ANALYTICS_DISPATCHER,
  inject: [queueConfig.KEY, AnalyticsQueueService, InlineAnalyticsDispatcher],
  useFactory: (
    cfg: ConfigType<typeof queueConfig>,
    redis: AnalyticsQueueService,
    inline: InlineAnalyticsDispatcher,
  ): IAnalyticsDispatcher => (cfg.queueDriver === 'redis' ? redis : inline),
};

const notificationsDispatcherProvider = {
  provide: NOTIFICATIONS_DISPATCHER,
  inject: [queueConfig.KEY, NotificationsQueueService, InlineNotificationsDispatcher],
  useFactory: (
    cfg: ConfigType<typeof queueConfig>,
    redis: NotificationsQueueService,
    inline: InlineNotificationsDispatcher,
  ): INotificationsDispatcher => (cfg.queueDriver === 'redis' ? redis : inline),
};

@Global()
@Module({
  imports: [ConfigModule.forFeature(queueConfig)],
  providers: [
    OcrQueueService,
    OcrHandwritingQueueService,
    AnalyticsQueueService,
    NotificationsQueueService,
    InlineOcrDispatcher,
    InlineAnalyticsDispatcher,
    InlineNotificationsDispatcher,
    ocrDispatcherProvider,
    analyticsDispatcherProvider,
    notificationsDispatcherProvider,
  ],
  exports: [
    OcrQueueService,
    OcrHandwritingQueueService,
    AnalyticsQueueService,
    NotificationsQueueService,
    OCR_DISPATCHER,
    ANALYTICS_DISPATCHER,
    NOTIFICATIONS_DISPATCHER,
  ],
})
export class QueueModule {}
