import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { ExamSectionModel } from '../models/exam-section.model';
import { EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';

@Injectable()
export class CreateExamSectionUseCase {
  constructor(@Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository) {}

  async execute(input: {
    actor: AuthenticatedUser;
    examId: string;
    name: string;
    position: number;
    timeLimitSeconds?: number;
  }): Promise<ExamSectionModel> {
    const exam = await this.exams.findById(input.actor.tenantId, input.examId);
    if (!exam) throw new NotFoundException('Exam not found');
    if (input.actor.role === Role.TEACHER && exam.createdBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only edit exams they created');
    }
    if (!exam.isEditable()) throw new ConflictException('Exam is not editable');
    return this.exams.createSection({
      tenantId: input.actor.tenantId,
      examId: input.examId,
      name: input.name,
      position: input.position,
      timeLimitSeconds: input.timeLimitSeconds,
    });
  }
}
