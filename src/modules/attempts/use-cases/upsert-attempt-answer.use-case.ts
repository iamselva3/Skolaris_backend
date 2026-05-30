import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../shared/database/prisma.service';
import { AttemptAnswerModel } from '../models/attempt-answer.model';
import {
  EXAM_ATTEMPT_REPOSITORY,
  IExamAttemptRepository,
} from '../repositories/exam-attempt.repository';

@Injectable()
export class UpsertAttemptAnswerUseCase {
  constructor(
    @Inject(EXAM_ATTEMPT_REPOSITORY) private readonly attempts: IExamAttemptRepository,
    private readonly prisma: PrismaService,
  ) {}

  async execute(input: {
    tenantId: string;
    studentId: string;
    attemptId: string;
    examQuestionId: string;
    answerPayload: Record<string, unknown> | null;
    timeSpentSeconds?: number;
    isFlagged?: boolean;
  }): Promise<AttemptAnswerModel> {
    const attempt = await this.attempts.findById(input.tenantId, input.attemptId);
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.studentId !== input.studentId) {
      throw new ForbiddenException('Not your attempt');
    }
    if (attempt.status !== 'IN_PROGRESS') {
      throw new ConflictException('Attempt is not in progress');
    }
    // Verify the exam_question belongs to the same exam.
    const eq = await this.prisma.examQuestion.findFirst({
      where: {
        id: input.examQuestionId,
        tenantId: input.tenantId,
        examId: attempt.examId,
      },
    });
    if (!eq) throw new NotFoundException('Question not in this exam');

    return this.attempts.upsertAnswer({
      tenantId: input.tenantId,
      attemptId: attempt.id,
      examQuestionId: input.examQuestionId,
      answerPayload: input.answerPayload,
      timeSpentSeconds: input.timeSpentSeconds,
      isFlagged: input.isFlagged,
    });
  }
}
