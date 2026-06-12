import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/database/prisma.service';
import {
  EXAM_ATTEMPT_REPOSITORY,
  IExamAttemptRepository,
} from '../repositories/exam-attempt.repository';

export interface MyExamItem {
  attemptId: string;
  examId: string;
  examTitle: string;
  durationSeconds: number;
  totalMarks: number;
  opensAt: string | null;
  closesAt: string | null;
  status: string;
  score: number | null;
  submittedAt: string | null;
}

@Injectable()
export class ListMyExamsUseCase {
  constructor(
    @Inject(EXAM_ATTEMPT_REPOSITORY) private readonly attempts: IExamAttemptRepository,
    private readonly prisma: PrismaService,
  ) {}

  async execute(input: { tenantId: string; studentId: string }): Promise<MyExamItem[]> {
    const rows = await this.attempts.listForStudent(input.tenantId, input.studentId);
    if (rows.length === 0) return [];
    const examIds = Array.from(new Set(rows.map((r) => r.examId)));
    const exams = await this.prisma.exam.findMany({
      where: { id: { in: examIds }, tenantId: input.tenantId },
      select: {
        id: true,
        title: true,
        durationSeconds: true,
        totalMarks: true,
        opensAt: true,
        closesAt: true,
      },
    });
    const examMap = new Map(exams.map((e) => [e.id, e]));
    return rows.map((a) => {
      const e = examMap.get(a.examId);
      return {
        attemptId: a.id,
        examId: a.examId,
        examTitle: e?.title ?? '(missing)',
        durationSeconds: e?.durationSeconds ?? 0,
        totalMarks: e?.totalMarks ? Number(e.totalMarks) : 0,
        opensAt: e?.opensAt?.toISOString() ?? null,
        closesAt: e?.closesAt?.toISOString() ?? null,
        status: a.status,
        score: a.score ? Number(a.score) : null,
        submittedAt: a.submittedAt?.toISOString() ?? null,
      };
    });
  }
}
