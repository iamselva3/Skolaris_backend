import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';

@Injectable()
export class DeleteExamUseCase {
  constructor(@Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository) {}

  async execute(input: { actor: AuthenticatedUser; id: string }): Promise<void> {
    const target = await this.exams.findById(input.actor.tenantId, input.id);
    if (!target) throw new NotFoundException('Exam not found');
    if (input.actor.role === Role.TEACHER && target.createdBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only delete exams they created');
    }
    if (target.status !== 'DRAFT') {
      throw new ConflictException('Only DRAFT exams can be deleted');
    }
    await this.exams.delete(input.actor.tenantId, input.id);
  }
}
