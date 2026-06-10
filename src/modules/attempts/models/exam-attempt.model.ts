import { Decimal } from '@prisma/client/runtime/library';

export type AttemptStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'SUBMITTED' | 'GRADED' | 'FLAGGED';

export class ExamAttemptModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly examId: string,
    public readonly studentId: string,
    public readonly status: AttemptStatus,
    public readonly startedAt: Date | null,
    public readonly submittedAt: Date | null,
    public readonly gradedAt: Date | null,
    public readonly timeRemainingSeconds: number | null,
    public readonly score: Decimal | null,
    public readonly autoSubmitted: boolean,
    public readonly questionOrderSeed: bigint,
    public readonly violationCount: number,
    public readonly descriptivePending: boolean,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}
}
