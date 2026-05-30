import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../shared/database/prisma.service';
import { AntiCheatConfig, DEFAULT_ANTI_CHEAT_CONFIG } from '../../exams/models/exam.model';
import { GradeAttemptUseCase } from '../../attempts/use-cases/grade-attempt.use-case';
import {
  EXAM_ATTEMPT_REPOSITORY,
  IExamAttemptRepository,
} from '../../attempts/repositories/exam-attempt.repository';
import { ViolationType } from '../models/violation.model';
import {
  IViolationRepository,
  VIOLATION_REPOSITORY,
} from '../repositories/violation.repository';

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
    const exam = await this.prisma.exam.findUniqueOrThrow({ where: { id: attempt.examId } });
    const cfg: AntiCheatConfig = {
      ...DEFAULT_ANTI_CHEAT_CONFIG,
      ...((exam.antiCheatConfig as unknown as Partial<AntiCheatConfig>) ?? {}),
    };

    // Write rows + bump violation_count + (maybe) auto-submit, all in one tx.
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

      const totalCount = updated.violationCount;
      const tabSwitchCount = input.events.some((e) => e.type === 'TAB_SWITCH')
        ? await this.violations.countByAttemptAndType(
            input.tenantId,
            input.attemptId,
            'TAB_SWITCH',
          )
        : 0;

      let autoSubmitted = false;
      let flagged = false;

      if (
        cfg.totalViolationThreshold > 0 &&
        totalCount >= cfg.totalViolationThreshold
      ) {
        autoSubmitted = true;
      }
      if (
        !autoSubmitted &&
        cfg.tabSwitchThreshold > 0 &&
        tabSwitchCount >= cfg.tabSwitchThreshold
      ) {
        autoSubmitted = true;
      }
      if (
        !autoSubmitted &&
        cfg.flagAtViolationCount > 0 &&
        totalCount >= cfg.flagAtViolationCount
      ) {
        flagged = true;
        await this.attempts.setStatus(input.tenantId, input.attemptId, 'FLAGGED');
      }

      if (autoSubmitted) {
        await this.attempts.submit({
          tenantId: input.tenantId,
          id: input.attemptId,
          autoSubmitted: true,
        });
      }

      return { inserted, totalViolations: totalCount, autoSubmitted, flagged };
    });

    if (result.autoSubmitted) {
      // Grading runs outside the violation tx (it has its own tx + analytics enqueue).
      await this.grader.execute({ tenantId: input.tenantId, attemptId: input.attemptId });
    }

    return result;
  }
}
