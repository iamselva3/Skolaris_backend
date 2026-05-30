import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../shared/database/prisma.service';
import { ExamAttemptModel } from '../models/exam-attempt.model';
import {
  EXAM_ATTEMPT_REPOSITORY,
  IExamAttemptRepository,
} from '../repositories/exam-attempt.repository';

// Tiny deterministic shuffle using question_order_seed.
const seededShuffle = <T>(arr: T[], seed: bigint): T[] => {
  let s = seed === 0n ? 1n : seed;
  const out = [...arr];
  // xorshift64
  const next = (): number => {
    s ^= s << 13n;
    s &= 0xffffffffffffffffn;
    s ^= s >> 7n;
    s ^= s << 17n;
    s &= 0xffffffffffffffffn;
    return Number(s & 0xffffffffn);
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

export interface StartAttemptResult {
  attempt: ExamAttemptModel;
  questions: Array<{
    examQuestionId: string;
    questionId: string;
    type: string;
    payload: Record<string, unknown>;     // sanitized — no answer-key fields
    options: Array<{ id: string; label: string; position: number }>;  // no isCorrect
    marks: number;
    negativeMarks: number;
  }>;
}

@Injectable()
export class StartAttemptUseCase {
  constructor(
    @Inject(EXAM_ATTEMPT_REPOSITORY) private readonly attempts: IExamAttemptRepository,
    private readonly prisma: PrismaService,
  ) {}

  async execute(input: {
    tenantId: string;
    studentId: string;
    examId: string;
  }): Promise<StartAttemptResult> {
    const exam = await this.prisma.exam.findFirst({
      where: { id: input.examId, tenantId: input.tenantId },
    });
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.status === 'DRAFT' || exam.status === 'CLOSED') {
      throw new ConflictException(`Exam is ${exam.status}; cannot start`);
    }
    const now = new Date();
    if (exam.opensAt && now < exam.opensAt) {
      throw new ForbiddenException('Exam has not opened yet');
    }
    if (exam.closesAt && now > exam.closesAt) {
      throw new ForbiddenException('Exam window has closed');
    }

    let attempt = await this.attempts.findByExamAndStudent(
      input.tenantId,
      input.examId,
      input.studentId,
    );
    if (!attempt) {
      throw new ForbiddenException('You are not assigned to this exam');
    }
    if (attempt.status === 'SUBMITTED' || attempt.status === 'GRADED') {
      throw new ConflictException('Attempt already submitted');
    }
    if (attempt.status === 'NOT_STARTED') {
      attempt = await this.attempts.start({
        tenantId: input.tenantId,
        id: attempt.id,
        timeRemainingSeconds: exam.durationSeconds,
      });
    }

    // Fetch + (optionally) shuffle questions and options.
    const examQuestions = await this.prisma.examQuestion.findMany({
      where: { tenantId: input.tenantId, examId: input.examId },
      include: { question: { include: { options: { orderBy: { position: 'asc' } } } } },
      orderBy: { position: 'asc' },
    });
    const ordered = exam.randomizeQuestions
      ? seededShuffle(examQuestions, attempt.questionOrderSeed)
      : examQuestions;

    const stripped = ordered.map((eq) => {
      const opts = eq.question.options.map((o) => ({
        id: o.id,
        label: o.label,
        position: o.position,
      }));
      const finalOpts = exam.randomizeOptions ? seededShuffle(opts, attempt.questionOrderSeed) : opts;
      // Sanitize payload — strip fields that reveal the answer for non-choice types.
      const payload = sanitizePayload(eq.question.type, eq.question.payload as Record<string, unknown>);
      return {
        examQuestionId: eq.id,
        questionId: eq.questionId,
        type: eq.question.type,
        payload,
        options: finalOpts,
        marks: Number(eq.marks),
        negativeMarks: Number(eq.negativeMarks),
      };
    });

    return { attempt, questions: stripped };
  }
}

/**
 * Build the payload a STUDENT sees during an attempt. Always preserves the
 * question stem (`contentHtml`) so the question renders, while withholding
 * anything that reveals the answer — `explanation` (post-submit reveal),
 * correct flags, and answer keys. Previously this stripped `contentHtml` for
 * non-choice types (students saw a UUID fallback) AND leaked `explanation`
 * for choice types via the `default` branch.
 */
const sanitizePayload = (
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> => {
  const contentHtml = typeof payload.contentHtml === 'string' ? payload.contentHtml : '';
  const base: Record<string, unknown> = { contentHtml };
  switch (type) {
    case 'TRUE_FALSE':
      return base;
    case 'FILL_BLANK':
      return { ...base, caseSensitive: payload.caseSensitive ?? false };
    case 'MATCH_FOLLOWING': {
      const pairs = (payload.pairs as Array<{ left: string; right: string }> | undefined) ?? [];
      return {
        ...base,
        lefts: pairs.map((p) => p.left),
        rights: shuffleStrings(pairs.map((p) => p.right)),
      };
    }
    case 'MATRIX_MATCH':
      return { ...base, rows: payload.rows ?? [], cols: payload.cols ?? [] };
    case 'DESCRIPTIVE':
      return { ...base, rubric: payload.rubric ?? null, maxWords: payload.maxWords ?? null };
    case 'SINGLE_CHOICE':
    case 'MULTIPLE_CHOICE':
      // Options carry their labels separately (isCorrect stripped by the
      // caller). Only the stem is needed here; explanation is withheld.
      return base;
    default:
      return base;
  }
};

const shuffleStrings = (arr: string[]): string[] => {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
