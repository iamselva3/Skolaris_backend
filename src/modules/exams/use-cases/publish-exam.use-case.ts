import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../shared/database/prisma.service';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import {
  EXAM_ATTEMPT_REPOSITORY,
  IExamAttemptRepository,
} from '../../attempts/repositories/exam-attempt.repository';
import { CreateNotificationUseCase } from '../../notifications/use-cases/create-notification.use-case';
import { ExamModel } from '../models/exam.model';
import { EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';

export interface PublishExamResult {
  exam: ExamModel;
  attemptsCreated: number;
  notificationsCreated: number;
}

@Injectable()
export class PublishExamUseCase {
  private readonly logger = new Logger(PublishExamUseCase.name);

  constructor(
    @Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository,
    @Inject(EXAM_ATTEMPT_REPOSITORY) private readonly attempts: IExamAttemptRepository,
    private readonly notifications: CreateNotificationUseCase,
    private readonly prisma: PrismaService,
  ) {}

  async execute(input: { actor: AuthenticatedUser; examId: string }): Promise<PublishExamResult> {
    const detail = await this.exams.findDetail(input.actor.tenantId, input.examId);
    if (!detail) throw new NotFoundException('Exam not found');
    const exam = detail.exam;

    if (input.actor.role === Role.TEACHER && exam.createdBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only publish exams they created');
    }
    if (exam.status !== 'DRAFT') {
      throw new ConflictException(`Exam is in status ${exam.status}; only DRAFT exams can be published`);
    }

    if (detail.questions.length === 0) {
      throw new BadRequestException('Exam has no questions');
    }
    if (detail.assignments.length === 0) {
      throw new BadRequestException('Exam has no assignments');
    }
    // If opens_at/closes_at supplied, both must be present and in correct order.
    if (exam.opensAt && exam.closesAt && exam.closesAt.getTime() <= exam.opensAt.getTime()) {
      throw new BadRequestException('closesAt must be after opensAt');
    }

    const studentIds = await this.exams.expandAssignmentsToStudentIds(
      input.actor.tenantId,
      input.examId,
    );
    if (studentIds.length === 0) {
      throw new BadRequestException('Exam assignments resolved to zero students');
    }

    const attemptsCreated = await this.prisma.$transaction(async () => {
      return this.attempts.bulkCreate({
        tenantId: input.actor.tenantId,
        examId: input.examId,
        studentIds,
      });
    });

    const now = new Date();
    const goLive = exam.opensAt !== null && exam.opensAt.getTime() <= now.getTime();
    const updated = await this.exams.setStatus(
      input.actor.tenantId,
      input.examId,
      goLive ? 'LIVE' : 'SCHEDULED',
      now,
    );

    // Resolve student → user id mapping to address notifications correctly.
    const studentRows = await this.prisma.student.findMany({
      where: { id: { in: studentIds }, tenantId: input.actor.tenantId },
      include: { user: { select: { id: true, name: true } } },
    });
    let notificationsCreated = 0;
    for (const s of studentRows) {
      await this.notifications.execute({
        tenantId: input.actor.tenantId,
        recipientUserId: s.user.id,
        channel: 'IN_APP',
        subject: `New exam scheduled: ${exam.title}`,
        body: `An exam "${exam.title}" has been assigned to you. Log in to take it during the open window.`,
      });
      // EMAIL channel — handled by the dispatch worker, which actually sends.
      await this.notifications.execute({
        tenantId: input.actor.tenantId,
        recipientUserId: s.user.id,
        channel: 'EMAIL',
        subject: `New exam scheduled: ${exam.title}`,
        body: this.examPublishedEmailBody(s.user.name, exam),
      });
      notificationsCreated += 2;
    }
    this.logger.log(
      `Exam ${exam.id} published. attempts=${attemptsCreated} notifications=${notificationsCreated}`,
    );

    return { exam: updated, attemptsCreated, notificationsCreated };
  }

  private examPublishedEmailBody(name: string, exam: ExamModel): string {
    return [
      `Hello ${name},`,
      ``,
      `A new exam "${exam.title}" has been scheduled.`,
      `Duration: ${Math.round(exam.durationSeconds / 60)} minutes`,
      exam.opensAt ? `Opens: ${exam.opensAt.toISOString()}` : '',
      exam.closesAt ? `Closes: ${exam.closesAt.toISOString()}` : '',
      ``,
      `Log in to SKOLARIS during the open window to take it.`,
    ]
      .filter(Boolean)
      .join('\n');
  }
}
