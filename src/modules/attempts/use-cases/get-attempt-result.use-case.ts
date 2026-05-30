import {
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../shared/database/prisma.service';
import {
  EXAM_ATTEMPT_REPOSITORY,
  IExamAttemptRepository,
} from '../repositories/exam-attempt.repository';

export interface AttemptResult {
  attemptId: string;
  examId: string;
  examTitle: string;
  score: number;
  totalMarks: number;
  status: string;
  autoSubmitted: boolean;
  descriptivePending: boolean;
  perQuestion: Array<{
    examQuestionId: string;
    questionId: string;
    isCorrect: boolean | null;
    marksAwarded: number | null;
    timeSpentSeconds: number;
  }>;
}

@Injectable()
export class GetAttemptResultUseCase {
  constructor(
    @Inject(EXAM_ATTEMPT_REPOSITORY) private readonly attempts: IExamAttemptRepository,
    private readonly prisma: PrismaService,
  ) {}

  async execute(input: {
    tenantId: string;
    studentId: string;
    attemptId: string;
  }): Promise<AttemptResult> {
    const attempt = await this.attempts.findById(input.tenantId, input.attemptId);
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.studentId !== input.studentId) {
      throw new ForbiddenException('Not your attempt');
    }
    if (attempt.status !== 'GRADED' && attempt.status !== 'FLAGGED') {
      // 425 Too Early — still grading.
      throw new HttpException(
        { statusCode: 425, error: 'TooEarly', message: 'Attempt is still being graded' },
        425,
      );
    }
    const [exam, answers] = await Promise.all([
      this.prisma.exam.findUniqueOrThrow({ where: { id: attempt.examId } }),
      this.attempts.listAnswers(input.tenantId, attempt.id),
    ]);
    const eqRows = await this.prisma.examQuestion.findMany({
      where: { examId: attempt.examId, tenantId: input.tenantId },
      select: { id: true, questionId: true },
    });
    const eqMap = new Map(eqRows.map((e) => [e.id, e.questionId]));
    return {
      attemptId: attempt.id,
      examId: exam.id,
      examTitle: exam.title,
      score: attempt.score ? Number(attempt.score) : 0,
      totalMarks: Number(exam.totalMarks),
      status: attempt.status,
      autoSubmitted: attempt.autoSubmitted,
      descriptivePending: attempt.descriptivePending,
      perQuestion: answers.map((a) => ({
        examQuestionId: a.examQuestionId,
        questionId: eqMap.get(a.examQuestionId) ?? '',
        isCorrect: a.isCorrect,
        marksAwarded: a.marksAwarded ? Number(a.marksAwarded) : null,
        timeSpentSeconds: a.timeSpentSeconds,
      })),
    };
  }
}
