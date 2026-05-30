import { Decimal } from '@prisma/client/runtime/library';

export class QuestionStatModel {
  constructor(
    public readonly questionId: string,
    public readonly tenantId: string,
    public readonly totalAttempts: number,
    public readonly correctAttempts: number,
    public readonly avgTimeSeconds: Decimal,
    public readonly difficultyScore: Decimal | null,
    public readonly lastRecomputedAt: Date,
  ) {}
}

export class TopicReportModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly studentId: string,
    public readonly subject: string,
    public readonly topic: string,
    public readonly attemptsCount: number,
    public readonly correctCount: number,
    public readonly scorePercent: Decimal,
    public readonly isWeak: boolean,
    public readonly lastRecomputedAt: Date,
  ) {}
}
