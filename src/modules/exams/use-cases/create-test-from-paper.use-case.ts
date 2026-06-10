import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { Role } from '../../../shared/common/enums/role.enum';
import { ExamModel } from '../models/exam.model';
import { EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';

/**
 * Promotes a Question Paper (kind='PAPER') into a fresh Test (kind='TEST'):
 * deep-clones the Exam row + ExamSection + ExamQuestion rows into a new
 * status=DRAFT exam attributed to the actor, with opensAt/closesAt nulled out.
 * The user must then set the schedule, add assignments, and publish via the
 * existing test lifecycle.
 *
 * This is the ONLY supported path to convert a paper into a test — papers
 * cannot be published in place (see PublishExamUseCase guard).
 *
 * Authorization mirrors the rest of the exams module: TEACHER may promote only
 * papers they own; SUPER_ADMIN may promote any paper in their tenant.
 */
@Injectable()
export class CreateTestFromPaperUseCase {
  constructor(@Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository) {}

  async execute(input: { actor: AuthenticatedUser; paperId: string }): Promise<ExamModel> {
    const source = await this.exams.findById(input.actor.tenantId, input.paperId);
    if (!source) {
      throw new ForbiddenException('Question paper not found or not accessible');
    }
    if (!source.isPaper()) {
      throw new ConflictException(
        'Source is not a Question Paper; only papers can be promoted to tests.',
      );
    }
    if (input.actor.role === Role.TEACHER && source.createdBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only create tests from papers they own');
    }
    return this.exams.cloneExam({
      tenantId: input.actor.tenantId,
      sourceId: input.paperId,
      newCreatedBy: input.actor.sub,
      kind: 'TEST',
    });
  }
}
