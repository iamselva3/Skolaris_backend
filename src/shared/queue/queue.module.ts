import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { queueConfig } from '../config/queue.config';
import { AnalyticsQueueService } from './analytics-queue.service';
import { NotificationsQueueService } from './notifications-queue.service';
import { OcrHandwritingQueueService } from './ocr-handwriting-queue.service';
import { OcrQueueService } from './ocr-queue.service';
import { InlineOcrDispatcher } from './inline-ocr-dispatcher.service';
import { OCR_DISPATCHER, IOcrDispatcher } from './ocr-dispatcher';

/**
 * OCR_DISPATCHER resolves to the BullMQ producer (QUEUE_DRIVER=redis) or the
 * in-process dispatcher (QUEUE_DRIVER=inline, default). Both candidates are
 * instantiated, but OcrQueueService is lazy so the unused one opens no Redis
 * connection — flipping QUEUE_DRIVER back to 'redis' needs no code change.
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

@Global()
@Module({
  imports: [ConfigModule.forFeature(queueConfig)],
  providers: [
    OcrQueueService,
    OcrHandwritingQueueService,
    AnalyticsQueueService,
    NotificationsQueueService,
    InlineOcrDispatcher,
    ocrDispatcherProvider,
  ],
  exports: [
    OcrQueueService,
    OcrHandwritingQueueService,
    AnalyticsQueueService,
    NotificationsQueueService,
    OCR_DISPATCHER,
  ],
})
export class QueueModule {}
