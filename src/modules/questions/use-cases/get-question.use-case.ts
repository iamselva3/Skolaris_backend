import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { QuestionWithOptions } from '../models/question.model';
import {
  IQuestionRepository,
  QUESTION_REPOSITORY,
} from '../repositories/question.repository';

@Injectable()
export class GetQuestionUseCase {
  constructor(@Inject(QUESTION_REPOSITORY) private readonly questions: IQuestionRepository) {}

  async execute(input: { tenantId: string; id: string }): Promise<QuestionWithOptions> {
    const r = await this.questions.findById(input.tenantId, input.id);
    if (!r) throw new NotFoundException('Question not found');
    return r;
  }
}
