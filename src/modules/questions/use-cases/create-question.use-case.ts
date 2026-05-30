import { Inject, Injectable } from '@nestjs/common';
import { TaxonomyResolverService } from '../../taxonomy/services/taxonomy-resolver.service';
import { Difficulty, QuestionType } from '../models/question-type.enum';
import { QuestionWithOptions } from '../models/question.model';
import {
  IQuestionRepository,
  QUESTION_REPOSITORY,
} from '../repositories/question.repository';
import { QuestionPayloadValidator } from '../services/question-payload-validator.service';

export interface CreateQuestionInput {
  tenantId: string;
  createdBy: string;
  sourceUploadId?: string | null;
  type: QuestionType;
  payload: Record<string, unknown>;
  options?: { label: string; isCorrect: boolean }[];
  programId?: string;
  subjectId?: string;
  topicId?: string;
  chapterId?: string;
  subject?: string;
  topic?: string;
  difficulty?: Difficulty;
}

@Injectable()
export class CreateQuestionUseCase {
  constructor(
    @Inject(QUESTION_REPOSITORY) private readonly questions: IQuestionRepository,
    private readonly validator: QuestionPayloadValidator,
    private readonly taxonomy: TaxonomyResolverService,
  ) {}

  async execute(input: CreateQuestionInput): Promise<QuestionWithOptions> {
    this.validator.validate({
      type: input.type,
      payload: input.payload,
      options: input.options,
    });

    // Validate FK chain and resolve subject/topic names for denormalization.
    const resolved = await this.taxonomy.resolve(input.tenantId, {
      programId: input.programId,
      subjectId: input.subjectId,
      topicId: input.topicId,
      chapterId: input.chapterId,
    });

    // When FKs are supplied, derive subject/topic strings from the resolved
    // names so analytics rollups (TopicReport) stay aligned with the taxonomy.
    // Free-text subject/topic on the body is only used when no FK is supplied.
    const subjectStr = resolved.subject?.name ?? input.subject ?? null;
    const topicStr = resolved.topic?.name ?? input.topic ?? null;

    return this.questions.create({
      tenantId: input.tenantId,
      createdBy: input.createdBy,
      sourceUploadId: input.sourceUploadId ?? null,
      type: input.type,
      payload: input.payload,
      programId: input.programId ?? null,
      subjectId: input.subjectId ?? null,
      topicId: input.topicId ?? null,
      chapterId: input.chapterId ?? null,
      subject: subjectStr,
      topic: topicStr,
      difficulty: input.difficulty,
      options: input.options?.map((o, i) => ({ ...o, position: i })),
    });
  }
}
