import { Inject, Injectable } from '@nestjs/common';
import { PaginatedResponse } from '../../../shared/common/dtos/paginated-response.dto';
import { CompositionStatus } from '../dtos/question-paper.dtos';
import { QuestionPaperRow } from '../dtos/question-paper-responses';
import { EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';

@Injectable()
export class ListQuestionPapersUseCase {
  constructor(@Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository) {}

  async execute(input: {
    tenantId: string;
    compositionStatus?: CompositionStatus;
    createdBy?: string;
    programId?: string;
    subjectId?: string;
    classroomId?: string;
    section?: string;
    q?: string;
    limit: number;
    offset: number;
  }): Promise<PaginatedResponse<QuestionPaperRow>> {
    const { data, total } = await this.exams.listWithCounts(input);
    return { data, meta: { total, limit: input.limit, offset: input.offset } };
  }
}
