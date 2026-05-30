import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ExamDetail, EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';

@Injectable()
export class GetExamUseCase {
  constructor(@Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository) {}

  async execute(input: { tenantId: string; id: string }): Promise<ExamDetail> {
    const detail = await this.exams.findDetail(input.tenantId, input.id);
    if (!detail) throw new NotFoundException('Exam not found');
    return detail;
  }
}
