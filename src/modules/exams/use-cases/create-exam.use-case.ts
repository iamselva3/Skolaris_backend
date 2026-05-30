import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { TaxonomyResolverService } from '../../taxonomy/services/taxonomy-resolver.service';
import { AntiCheatConfig, ExamModel, TestMode } from '../models/exam.model';
import { EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';

export interface CreateExamInput {
  actor: AuthenticatedUser;
  title: string;
  description?: string;
  durationSeconds: number;
  defaultNegativeMarks?: number;
  randomizeQuestions?: boolean;
  randomizeOptions?: boolean;
  opensAt?: string;
  closesAt?: string;
  testMode?: TestMode;
  programId?: string;
  subjectId?: string;
  antiCheatConfig?: Partial<AntiCheatConfig>;
}

@Injectable()
export class CreateExamUseCase {
  constructor(
    @Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository,
    private readonly taxonomy: TaxonomyResolverService,
  ) {}

  async execute(input: CreateExamInput): Promise<ExamModel> {
    await this.taxonomy.resolve(input.actor.tenantId, {
      programId: input.programId,
      subjectId: input.subjectId,
    });

    return this.exams.create({
      tenantId: input.actor.tenantId,
      createdBy: input.actor.sub,
      title: input.title,
      description: input.description ?? null,
      durationSeconds: input.durationSeconds,
      defaultNegativeMarks: input.defaultNegativeMarks,
      randomizeQuestions: input.randomizeQuestions,
      randomizeOptions: input.randomizeOptions,
      opensAt: input.opensAt ? new Date(input.opensAt) : null,
      closesAt: input.closesAt ? new Date(input.closesAt) : null,
      testMode: input.testMode,
      programId: input.programId ?? null,
      subjectId: input.subjectId ?? null,
      antiCheatConfig: input.antiCheatConfig,
    });
  }
}
