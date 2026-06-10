import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { Role } from '../../../shared/common/enums/role.enum';
import { ExamModel } from '../models/exam.model';
import { EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';

/**
 * Duplicates a Question Paper (kind='PAPER') as a new DRAFT paper (paper → paper).
 * The clone references the same Question ids (composition, not snapshot).
 *
 * REFUSES sources that are kind='TEST' — promoting a test back to a paper would
 * blur the asset boundary; the legitimate operation in that direction is to
 * create a NEW paper from scratch.
 *
 * Authorization mirrors the rest of the exams module: TEACHER may clone only
 * papers they own (createdBy = actor.sub); SUPER_ADMIN may clone any paper in
 * their tenant. The clone is attributed to the actor.
 */
@Injectable()
export class CloneQuestionPaperUseCase {
  constructor(@Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository) {}

  async execute(input: { actor: AuthenticatedUser; sourceId: string }): Promise<ExamModel> {
    const source = await this.exams.findById(input.actor.tenantId, input.sourceId);
    if (!source) {
      throw new ForbiddenException('Question paper not found or not accessible');
    }
    if (!source.isPaper()) {
      throw new ConflictException(
        'Only question papers can be cloned; tests cannot be duplicated as papers.',
      );
    }
    if (input.actor.role === Role.TEACHER && source.createdBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only clone their own question papers');
    }
    return this.exams.cloneExam({
      tenantId: input.actor.tenantId,
      sourceId: input.sourceId,
      newCreatedBy: input.actor.sub,
      // Preserve kind='PAPER' (no override; cloneExam preserves source kind by default).
    });
  }
}
