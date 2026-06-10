import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { TaxonomyResolverService } from '../../taxonomy/services/taxonomy-resolver.service';
import { Difficulty } from '../models/question-type.enum';
import { QuestionWithOptions } from '../models/question.model';
import {
  IQuestionRepository,
  QUESTION_REPOSITORY,
  UpdateQuestionInput as RepoUpdate,
} from '../repositories/question.repository';
import { QuestionPayloadValidator } from '../services/question-payload-validator.service';

export interface UpdateQuestionInput {
  actor: AuthenticatedUser;
  id: string;
  payload?: Record<string, unknown>;
  options?: { label: string; isCorrect: boolean }[];
  programId?: string;
  subjectId?: string;
  topicId?: string;
  chapterId?: string;
  subject?: string;
  topic?: string;
  difficulty?: Difficulty;
  isActive?: boolean;
}

@Injectable()
export class UpdateQuestionUseCase {
  constructor(
    @Inject(QUESTION_REPOSITORY) private readonly questions: IQuestionRepository,
    private readonly validator: QuestionPayloadValidator,
    private readonly taxonomy: TaxonomyResolverService,
  ) {}

  async execute(input: UpdateQuestionInput): Promise<QuestionWithOptions> {
    const target = await this.questions.findById(input.actor.tenantId, input.id);
    if (!target) throw new NotFoundException('Question not found');
    if (input.actor.role === Role.TEACHER && target.question.createdBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only edit questions they created');
    }

    const repoInput: RepoUpdate = {};
    const taxonomyTouched =
      input.programId !== undefined ||
      input.subjectId !== undefined ||
      input.topicId !== undefined ||
      input.chapterId !== undefined;

    if (taxonomyTouched) {
      const resolved = await this.taxonomy.resolve(input.actor.tenantId, {
        programId: input.programId,
        subjectId: input.subjectId,
        topicId: input.topicId,
        chapterId: input.chapterId,
      });
      if (input.programId !== undefined) repoInput.programId = input.programId ?? null;
      if (input.subjectId !== undefined) {
        repoInput.subjectId = input.subjectId ?? null;
        repoInput.subject = resolved.subject?.name ?? null;
      }
      if (input.topicId !== undefined) {
        repoInput.topicId = input.topicId ?? null;
        repoInput.topic = resolved.topic?.name ?? null;
      }
      if (input.chapterId !== undefined) repoInput.chapterId = input.chapterId ?? null;
    }

    // Free-text subject/topic only honoured if no taxonomy FK provided this call.
    if (input.subject !== undefined && repoInput.subject === undefined)
      repoInput.subject = input.subject;
    if (input.topic !== undefined && repoInput.topic === undefined) repoInput.topic = input.topic;
    if (input.difficulty !== undefined) repoInput.difficulty = input.difficulty;
    if (input.isActive !== undefined) repoInput.isActive = input.isActive;

    if (input.payload !== undefined || input.options !== undefined) {
      const payload = input.payload ?? target.question.payload;
      const options =
        input.options ?? target.options.map((o) => ({ label: o.label, isCorrect: o.isCorrect }));
      this.validator.validate({ type: target.question.type, payload, options });
      if (input.payload !== undefined) repoInput.payload = payload;
      if (input.options !== undefined) {
        repoInput.options = options.map((o, i) => ({ ...o, position: i }));
      }
    }

    if (Object.keys(repoInput).length === 0) {
      throw new BadRequestException('No fields to update');
    }
    return this.questions.update(input.actor.tenantId, input.id, repoInput);
  }
}
