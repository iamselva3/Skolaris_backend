import { Decimal } from '@prisma/client/runtime/library';

export class AttemptAnswerModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly attemptId: string,
    public readonly examQuestionId: string,
    public readonly answerPayload: Record<string, unknown> | null,
    public readonly isCorrect: boolean | null,
    public readonly marksAwarded: Decimal | null,
    public readonly timeSpentSeconds: number,
    public readonly isFlaggedByStudent: boolean,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}
}
