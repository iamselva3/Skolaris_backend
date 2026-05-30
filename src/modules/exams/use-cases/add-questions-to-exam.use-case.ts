import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { ExamQuestionModel } from '../models/exam-question.model';
import { EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';

export interface AddItem {
  questionId: string;
  sectionId?: string;
  position: number;
  marks: number;
  negativeMarks?: number;
}

@Injectable()
export class AddQuestionsToExamUseCase {
  constructor(@Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository) {}

  async execute(input: {
    actor: AuthenticatedUser;
    examId: string;
    items: AddItem[];
  }): Promise<ExamQuestionModel[]> {
    const exam = await this.exams.findById(input.actor.tenantId, input.examId);
    if (!exam) throw new NotFoundException('Exam not found');
    if (input.actor.role === Role.TEACHER && exam.createdBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only edit exams they created');
    }
    if (!exam.isEditable()) throw new ConflictException('Exam is not editable');

    const created = await this.exams.addExamQuestions({
      tenantId: input.actor.tenantId,
      examId: input.examId,
      items: input.items,
    });
    await this.exams.recomputeTotalMarks(input.actor.tenantId, input.examId);
    return created;
  }
}
