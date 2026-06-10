import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { ANALYTICS_DISPATCHER, IAnalyticsDispatcher } from '../queue/analytics-dispatcher';

@Injectable()
export class TransitionExamStatusCron {
  private readonly logger = new Logger(TransitionExamStatusCron.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ANALYTICS_DISPATCHER) private readonly analyticsQueue: IAnalyticsDispatcher,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    const now = new Date();

    // SCHEDULED → LIVE
    const goneLive = await this.prisma.exam.updateMany({
      where: { status: 'SCHEDULED', opensAt: { lte: now } },
      data: { status: 'LIVE' },
    });

    // LIVE → CLOSED, plus force-close lingering IN_PROGRESS attempts.
    const toClose = await this.prisma.exam.findMany({
      where: { status: 'LIVE', closesAt: { lte: now } },
      select: { id: true, tenantId: true },
    });
    let attemptsClosed = 0;
    for (const e of toClose) {
      const lingering = await this.prisma.examAttempt.findMany({
        where: { tenantId: e.tenantId, examId: e.id, status: 'IN_PROGRESS' },
        select: { id: true },
      });
      if (lingering.length > 0) {
        await this.prisma.examAttempt.updateMany({
          where: { id: { in: lingering.map((a) => a.id) } },
          data: { status: 'SUBMITTED', submittedAt: now, autoSubmitted: true },
        });
        for (const a of lingering) {
          await this.analyticsQueue.enqueue({ attemptId: a.id, tenantId: e.tenantId });
        }
        attemptsClosed += lingering.length;
      }
      await this.prisma.exam.update({
        where: { id: e.id },
        data: { status: 'CLOSED' },
      });
    }

    if (goneLive.count > 0 || toClose.length > 0) {
      this.logger.log(
        `Exam transitions: SCHEDULED→LIVE=${goneLive.count}, LIVE→CLOSED=${toClose.length}, attempts auto-closed=${attemptsClosed}`,
      );
    }
  }
}
