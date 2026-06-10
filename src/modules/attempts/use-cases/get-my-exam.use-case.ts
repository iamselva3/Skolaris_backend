import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../shared/database/prisma.service';
import {
  EXAM_ATTEMPT_REPOSITORY,
  IExamAttemptRepository,
} from '../repositories/exam-attempt.repository';

export interface MyExamMetadata {
  examId: string;
  title: string;
  description: string | null;
  durationSeconds: number;
  totalMarks: number;
  opensAt: string | null;
  closesAt: string | null;
  status: string;
  attempt: {
    id: string;
    status: string;
    timeRemainingSeconds: number | null;
  };
}

@Injectable()
export class GetMyExamUseCase {
  constructor(
    @Inject(EXAM_ATTEMPT_REPOSITORY) private readonly attempts: IExamAttemptRepository,
    private readonly prisma: PrismaService,
  ) {}

  async execute(input: {
    tenantId: string;
    studentId: string;
    examId: string;
  }): Promise<MyExamMetadata> {
    const exam = await this.prisma.exam.findFirst({
      where: { id: input.examId, tenantId: input.tenantId },
    });
    if (!exam) throw new NotFoundException('Exam not found');

    const attempt = await this.attempts.findByExamAndStudent(
      input.tenantId,
      input.examId,
      input.studentId,
    );
    if (!attempt) {
      throw new ForbiddenException('You are not assigned to this exam');
    }
    return {
      examId: exam.id,
      title: exam.title,
      description: exam.description,
      durationSeconds: exam.durationSeconds,
      totalMarks: Number(exam.totalMarks),
      opensAt: exam.opensAt?.toISOString() ?? null,
      closesAt: exam.closesAt?.toISOString() ?? null,
      status: exam.status,
      attempt: {
        id: attempt.id,
        status: attempt.status,
        timeRemainingSeconds: attempt.timeRemainingSeconds,
      },
    };
  }
}
