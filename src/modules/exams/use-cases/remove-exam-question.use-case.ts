import { Inject, Injectable } from '@nestjs/common';
import { EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';

@Injectable()
export class RemoveExamQuestionUseCase {
  constructor(@Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository) {}

  async execute(input: { tenantId: string; id: string }): Promise<void> {
    const { examId } = await this.exams.removeExamQuestion(input.tenantId, input.id);
    await this.exams.recomputeTotalMarks(input.tenantId, examId);
  }
}
