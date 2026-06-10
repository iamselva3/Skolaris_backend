import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { IQuestionRepository, QUESTION_REPOSITORY } from '../repositories/question.repository';

@Injectable()
export class DeleteQuestionUseCase {
  constructor(@Inject(QUESTION_REPOSITORY) private readonly questions: IQuestionRepository) {}

  async execute(input: { actor: AuthenticatedUser; id: string }): Promise<void> {
    const target = await this.questions.findById(input.actor.tenantId, input.id);
    if (!target) throw new NotFoundException('Question not found');
    if (input.actor.role === Role.TEACHER && target.question.createdBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only delete questions they created');
    }
    await this.questions.softDelete(input.actor.tenantId, input.id);
  }
}
