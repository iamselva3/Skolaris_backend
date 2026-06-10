import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { TaxonomyResolverService } from '../../taxonomy/services/taxonomy-resolver.service';
import { AntiCheatConfig, ExamModel } from '../models/exam.model';
import { EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';

export interface CreateQuestionPaperInput {
  actor: AuthenticatedUser;
  title: string;
  description?: string;
  durationSeconds: number;
  defaultNegativeMarks?: number;
  randomizeQuestions?: boolean;
  randomizeOptions?: boolean;
  programId?: string;
  subjectId?: string;
  antiCheatConfig?: Partial<AntiCheatConfig>;
}

/**
 * Creates a new Question Paper (kind='PAPER'). A paper is a composition asset:
 * it lives on the same Exam table as a test but never transitions out of DRAFT
 * and cannot be published or assigned. To deliver a paper to students the user
 * must explicitly promote it via CreateTestFromPaperUseCase.
 *
 * NOTE: opensAt/closesAt/testMode/publishedAt are intentionally NOT accepted
 * here — those are delivery (test) fields, not composition fields.
 */
@Injectable()
export class CreateQuestionPaperUseCase {
  constructor(
    @Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository,
    private readonly taxonomy: TaxonomyResolverService,
  ) {}

  async execute(input: CreateQuestionPaperInput): Promise<ExamModel> {
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
      programId: input.programId ?? null,
      subjectId: input.subjectId ?? null,
      antiCheatConfig: input.antiCheatConfig,
      kind: 'PAPER',
    });
  }
}
