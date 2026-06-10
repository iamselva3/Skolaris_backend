import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../shared/database/prisma.service';
import { EMAIL_SERVICE, IEmailService } from '../../../shared/email/email.interface';

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 100;

export interface DispatchResult {
  picked: number;
  sent: number;
  failed: number;
}

@Injectable()
export class DispatchPendingNotificationsUseCase {
  private readonly logger = new Logger(DispatchPendingNotificationsUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMAIL_SERVICE) private readonly email: IEmailService,
  ) {}

  async execute(): Promise<DispatchResult> {
    const candidates = await this.prisma.notification.findMany({
      where: {
        channel: 'EMAIL',
        sentAt: null,
        failedAt: null,
        attemptCount: { lt: MAX_ATTEMPTS },
      },
      include: { recipient: { select: { email: true, name: true } } },
      take: BATCH_SIZE,
      orderBy: { createdAt: 'asc' },
    });
    if (candidates.length === 0) return { picked: 0, sent: 0, failed: 0 };

    let sent = 0;
    let failed = 0;
    for (const n of candidates) {
      try {
        await this.email.send({
          to: n.recipient.email,
          subject: n.subject,
          html: this.toHtml(n.body),
        });
        await this.prisma.notification.update({
          where: { id: n.id },
          data: {
            sentAt: new Date(),
            attemptCount: { increment: 1 },
            errorMessage: null,
          },
        });
        sent += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const nextAttempt = n.attemptCount + 1;
        await this.prisma.notification.update({
          where: { id: n.id },
          data: {
            attemptCount: nextAttempt,
            errorMessage: message,
            failedAt: nextAttempt >= MAX_ATTEMPTS ? new Date() : null,
          },
        });
        this.logger.warn(
          `Notification ${n.id} send failed (attempt ${nextAttempt}/${MAX_ATTEMPTS}): ${message}`,
        );
        failed += 1;
      }
    }
    return { picked: candidates.length, sent, failed };
  }

  private toHtml(body: string): string {
    // Body is plain text — wrap to safe HTML.
    const escaped = body
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br/>');
    return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#1F2937;max-width:560px;margin:auto;padding:24px">${escaped}</body></html>`;
  }
}
