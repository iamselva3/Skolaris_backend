import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { ExamAssignmentModel } from '../models/exam-assignment.model';
import { EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';

@Injectable()
export class AssignExamUseCase {
  constructor(@Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository) {}

  async execute(input: {
    actor: AuthenticatedUser;
    examId: string;
    classroomIds: string[];
    studentIds: string[];
  }): Promise<ExamAssignmentModel[]> {
    const exam = await this.exams.findById(input.actor.tenantId, input.examId);
    if (!exam) throw new NotFoundException('Exam not found');
    if (input.actor.role === Role.TEACHER && exam.createdBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only assign exams they created');
    }
    if (exam.isPaper()) {
      throw new ConflictException(
        'Question papers cannot be assigned to students. Create a test from this paper first.',
      );
    }
    if (!exam.isEditable()) throw new ConflictException('Exam is not editable');

    return this.exams.createAssignments({
      tenantId: input.actor.tenantId,
      examId: input.examId,
      classroomIds: input.classroomIds,
      studentIds: input.studentIds,
    });
  }
}
