import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../../shared/database/prisma.service';
import { AnalyticsQueueService } from '../../../shared/queue/analytics-queue.service';
import { QuestionType } from '../../questions/models/question-type.enum';
import { GradingService } from '../grading/grading.service';
import { ExamAttemptModel } from '../models/exam-attempt.model';
import {
  EXAM_ATTEMPT_REPOSITORY,
  IExamAttemptRepository,
} from '../repositories/exam-attempt.repository';

export interface GradeAttemptResult {
  attempt: ExamAttemptModel;
  score: Decimal;
  descriptivePending: boolean;
}

@Injectable()
export class GradeAttemptUseCase {
  private readonly logger = new Logger(GradeAttemptUseCase.name);

  constructor(
    @Inject(EXAM_ATTEMPT_REPOSITORY) private readonly attempts: IExamAttemptRepository,
    private readonly grading: GradingService,
    private readonly prisma: PrismaService,
    private readonly analyticsQueue: AnalyticsQueueService,
  ) {}

  async execute(input: { tenantId: string; attemptId: string }): Promise<GradeAttemptResult> {
    const attempt = await this.attempts.findById(input.tenantId, input.attemptId);
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.status !== 'SUBMITTED' && attempt.status !== 'GRADED') {
      // Caller (Submit + Regrade) should have validated; this is defensive.
      this.logger.warn(`Grading attempt ${attempt.id} in unexpected status ${attempt.status}`);
    }

    // Fetch all exam_questions for this exam, with the underlying question + options.
    const examQuestions = await this.prisma.examQuestion.findMany({
      where: { tenantId: input.tenantId, examId: attempt.examId },
      include: {
        question: { include: { options: { orderBy: { position: 'asc' } } } },
      },
    });
    const answers = await this.attempts.listAnswers(input.tenantId, attempt.id);
    const answerByEqId = new Map(answers.map((a) => [a.examQuestionId, a]));

    let totalScore = new Decimal(0);
    let descriptivePending = false;

    for (const eq of examQuestions) {
      const ans = answerByEqId.get(eq.id);
      const result = this.grading.grade(
        {
          type: eq.question.type as QuestionType,
          payload: eq.question.payload as Record<string, unknown>,
          options: eq.question.options.map((o) => ({
            id: o.id,
            label: o.label,
            isCorrect: o.isCorrect,
            position: o.position,
          })),
          marks: eq.marks,
          negativeMarks: eq.negativeMarks,
        },
        { payload: ans?.answerPayload ?? null },
      );
      totalScore = totalScore.plus(result.marksAwarded);
      if (eq.question.type === QuestionType.DESCRIPTIVE && ans?.answerPayload) {
        descriptivePending = true;
      }

      if (ans) {
        await this.attempts.updateAnswerGrading({
          tenantId: input.tenantId,
          answerId: ans.id,
          isCorrect: result.isCorrect,
          marksAwarded: result.marksAwarded,
        });
      }
    }

    if (totalScore.lt(0)) totalScore = new Decimal(0); // floor at 0

    const updated = await this.attempts.setGradedScore({
      tenantId: input.tenantId,
      id: attempt.id,
      score: totalScore,
      descriptivePending,
    });

    // Fire analytics aggregation off the critical path.
    try {
      await this.analyticsQueue.enqueue({ attemptId: attempt.id, tenantId: input.tenantId });
    } catch (err) {
      this.logger.warn(
        `Failed to enqueue analytics for attempt ${attempt.id}: ${(err as Error).message}`,
      );
    }

    return { attempt: updated, score: totalScore, descriptivePending };
  }
}
