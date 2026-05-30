import { Inject, Injectable } from '@nestjs/common';
import { ExamSectionModel } from '../models/exam-section.model';
import { EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';

@Injectable()
export class UpdateExamSectionUseCase {
  constructor(@Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository) {}

  execute(input: {
    tenantId: string;
    id: string;
    name?: string;
    position?: number;
    timeLimitSeconds?: number | null;
  }): Promise<ExamSectionModel> {
    return this.exams.updateSection(input.tenantId, input.id, {
      name: input.name,
      position: input.position,
      timeLimitSeconds: input.timeLimitSeconds,
    });
  }
}
