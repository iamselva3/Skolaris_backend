import { Inject, Injectable } from '@nestjs/common';
import { PaginatedResponse } from '../../../shared/common/dtos/paginated-response.dto';
import { ExamModel, ExamStatus } from '../models/exam.model';
import { EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';

@Injectable()
export class ListExamsUseCase {
  constructor(@Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository) {}

  async execute(input: {
    tenantId: string;
    status?: ExamStatus;
    createdBy?: string;
    programId?: string;
    subjectId?: string;
    q?: string;
    limit: number;
    offset: number;
  }): Promise<PaginatedResponse<ExamModel>> {
    const { data, total } = await this.exams.list(input);
    return { data, meta: { total, limit: input.limit, offset: input.offset } };
  }
}
