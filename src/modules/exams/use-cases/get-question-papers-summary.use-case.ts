import { Inject, Injectable } from '@nestjs/common';
import { QuestionPapersSummary } from '../dtos/question-paper-responses';
import { EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';

@Injectable()
export class GetQuestionPapersSummaryUseCase {
  constructor(@Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository) {}

  async execute(input: { tenantId: string; createdBy?: string }): Promise<QuestionPapersSummary> {
    return this.exams.summarizeQuestionPapers(input);
  }
}
