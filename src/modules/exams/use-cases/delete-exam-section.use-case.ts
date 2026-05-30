import { Inject, Injectable } from '@nestjs/common';
import { EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';

@Injectable()
export class DeleteExamSectionUseCase {
  constructor(@Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository) {}

  execute(input: { tenantId: string; id: string }): Promise<void> {
    return this.exams.deleteSection(input.tenantId, input.id);
  }
}
