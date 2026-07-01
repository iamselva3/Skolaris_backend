import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../shared/database/prisma.service';
import { MAX_EXAM_VIOLATIONS } from '../../exams/models/exam.model';
import { GradeAttemptUseCase } from '../../attempts/use-cases/grade-attempt.use-case';
import {
  EXAM_ATTEMPT_REPOSITORY,
  IExamAttemptRepository,
} from '../../attempts/repositories/exam-attempt.repository';
import { ViolationType } from '../models/violation.model';
import { IViolationRepository, VIOLATION_REPOSITORY } from '../repositories/violation.repository';

export interface RecordViolationsResult {
  inserted: number;
  totalViolations: number;
  autoSubmitted: boolean;
  flagged: boolean;
}

export interface RecordViolationsInput {
  tenantId: string;
  studentId: string;
  attemptId: string;
  events: Array<{
    type: ViolationType;
    clientTimestamp: Date;
    detail?: Record<string, unknown>;
  }>;
}

@Injectable()
export class RecordViolationsUseCase {
  constructor(
    @Inject(VIOLATION_REPOSITORY) private readonly violations: IViolationRepository,
    @Inject(EXAM_ATTEMPT_REPOSITORY) private readonly attempts: IExamAttemptRepository,
    private readonly prisma: PrismaService,
    private readonly grader: GradeAttemptUseCase,
  ) {}

  async execute(input: RecordViolationsInput): Promise<RecordViolationsResult> {
    const attempt = await this.attempts.findById(input.tenantId, input.attemptId);
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.studentId !== input.studentId) {
      throw new ForbiddenException('Not your attempt');
    }
    if (attempt.status !== 'IN_PROGRESS') {
      throw new ConflictException('Attempt is not in progress');
    }

    // Write rows + bump violation_count + (maybe) auto-submit, all in one tx.
    // Single product rule: auto-submit once the attempt reaches the maximum total
    // number of violations (any type counts toward the same total). No separate
    // per-type threshold and no intermediate FLAGGED transition — both previously
    // interfered with reliably auto-submitting on the 6th violation.
    const result = await this.prisma.$transaction(async () => {
      const inserted = await this.violations.bulkCreate(
        input.events.map((e) => ({
          tenantId: input.tenantId,
          attemptId: input.attemptId,
          type: e.type,
          detail: e.detail ?? null,
          clientTimestamp: e.clientTimestamp,
        })),
      );
      const updated = await this.attempts.incrementViolationCount(
        input.tenantId,
        input.attemptId,
        inserted,
      );

      // Effective limit is the tenant-wide super-admin setting; fall back to the
      // historical default if the row predates the column or is somehow unset.
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: input.tenantId },
        select: { examViolationLimit: true },
      });
      const limit = tenant?.examViolationLimit ?? MAX_EXAM_VIOLATIONS;

      const totalCount = updated.violationCount;
      const autoSubmitted = totalCount >= limit;

      if (autoSubmitted) {
        await this.attempts.submit({
          tenantId: input.tenantId,
          id: input.attemptId,
          autoSubmitted: true,
        });
      }

      return { inserted, totalViolations: totalCount, autoSubmitted, flagged: false };
    });

    if (result.autoSubmitted) {
      // Grading runs outside the violation tx (it has its own tx + analytics enqueue).
      await this.grader.execute({ tenantId: input.tenantId, attemptId: input.attemptId });
    }

    return result;
  }
}
