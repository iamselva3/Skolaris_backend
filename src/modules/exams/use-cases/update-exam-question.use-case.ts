import { Inject, Injectable } from '@nestjs/common';
import { ExamQuestionModel } from '../models/exam-question.model';
import { EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';

@Injectable()
export class UpdateExamQuestionUseCase {
  constructor(@Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository) {}

  async execute(input: {
    tenantId: string;
    examId: string;
    id: string;
    position?: number;
    marks?: number;
    negativeMarks?: number;
    sectionId?: string | null;
  }): Promise<ExamQuestionModel> {
    const updated = await this.exams.updateExamQuestion(input.tenantId, input.id, {
      position: input.position,
      marks: input.marks,
      negativeMarks: input.negativeMarks,
      sectionId: input.sectionId,
    });
    if (input.marks !== undefined) {
      await this.exams.recomputeTotalMarks(input.tenantId, input.examId);
    }
    return updated;
  }
}
