import { Inject, Injectable } from '@nestjs/common';
import { PaginatedResponse } from '../../../shared/common/dtos/paginated-response.dto';
import { Difficulty, QuestionType } from '../models/question-type.enum';
import { QuestionWithOptions } from '../models/question.model';
import {
  IQuestionRepository,
  QUESTION_REPOSITORY,
} from '../repositories/question.repository';

@Injectable()
export class ListQuestionsUseCase {
  constructor(@Inject(QUESTION_REPOSITORY) private readonly questions: IQuestionRepository) {}

  async execute(input: {
    tenantId: string;
    programId?: string;
    subjectId?: string;
    topicId?: string;
    chapterId?: string;
    subject?: string;
    topic?: string;
    difficulty?: Difficulty;
    type?: QuestionType;
    q?: string;
    limit: number;
    offset: number;
  }): Promise<PaginatedResponse<QuestionWithOptions>> {
    const { data, total } = await this.questions.list({
      ...input,
      isActive: true,
    });
    return { data, meta: { total, limit: input.limit, offset: input.offset } };
  }
}
