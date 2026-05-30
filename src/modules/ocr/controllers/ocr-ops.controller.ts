import { Controller, Get, UseGuards } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { getBreakerState } from '../../../shared/ocr-engine/handwriting-http';
import { OcrHandwritingQueueService } from '../../../shared/queue/ocr-handwriting-queue.service';
import { OcrQueueService } from '../../../shared/queue/ocr-queue.service';
import { RoutingMetricsService } from '../services/routing-metrics.service';

/**
 * Operator observability for the OCR pipeline + handwriting fallback: queue
 * depth / connected workers for both queues, live routing counters, and the
 * inline-HTTP circuit-breaker state. The data an ops dashboard polls.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN, Role.TEACHER)
@Controller('ocr')
export class OcrOpsController {
  constructor(
    private readonly ocrQueue: OcrQueueService,
    private readonly handwritingQueue: OcrHandwritingQueueService,
    private readonly metrics: RoutingMetricsService,
  ) {}

  @Get('ops')
  async ops() {
    const [exWaiting, exActive, exWorkers, hwWaiting, hwActive, hwWorkers] = await Promise.all([
      this.ocrQueue.getWaitingCount(),
      this.ocrQueue.getActiveCount(),
      this.ocrQueue.getConnectedWorkerCount(),
      this.handwritingQueue.getWaitingCount(),
      this.handwritingQueue.getActiveCount(),
      this.handwritingQueue.getConnectedWorkerCount(),
    ]);
    return {
      data: {
        queues: {
          extract: { waiting: exWaiting, active: exActive, workers: exWorkers },
          handwriting: { waiting: hwWaiting, active: hwActive, workers: hwWorkers },
        },
        routing: this.metrics.snapshot(),
        httpBreaker: getBreakerState(),
      },
    };
  }
}
