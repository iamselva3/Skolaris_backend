import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../../../shared/common/enums/role.enum';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { TaxonomyResolverService } from '../../taxonomy/services/taxonomy-resolver.service';
import { AntiCheatConfig, ExamModel } from '../models/exam.model';
import {
  EXAM_REPOSITORY,
  IExamRepository,
  UpdateExamInput as RepoUpdate,
} from '../repositories/exam.repository';

export interface UpdateExamInput {
  actor: AuthenticatedUser;
  id: string;
  title?: string;
  description?: string | null;
  durationSeconds?: number;
  defaultNegativeMarks?: number;
  randomizeQuestions?: boolean;
  randomizeOptions?: boolean;
  opensAt?: string | null;
  closesAt?: string | null;
  programId?: string | null;
  subjectId?: string | null;
  antiCheatConfig?: Partial<AntiCheatConfig>;
}

@Injectable()
export class UpdateExamUseCase {
  constructor(
    @Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository,
    private readonly taxonomy: TaxonomyResolverService,
  ) {}

  async execute(input: UpdateExamInput): Promise<ExamModel> {
    const target = await this.exams.findById(input.actor.tenantId, input.id);
    if (!target) throw new NotFoundException('Exam not found');
    if (input.actor.role === Role.TEACHER && target.createdBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only edit exams they created');
    }

    const update: RepoUpdate = {};
    const isEditable = target.isEditable();

    if (input.title !== undefined)
      (this.assertEditable(isEditable, 'title'), (update.title = input.title));
    if (input.description !== undefined)
      (this.assertEditable(isEditable, 'description'), (update.description = input.description));
    if (input.durationSeconds !== undefined)
      (this.assertEditable(isEditable, 'durationSeconds'),
        (update.durationSeconds = input.durationSeconds));
    if (input.defaultNegativeMarks !== undefined)
      (this.assertEditable(isEditable, 'defaultNegativeMarks'),
        (update.defaultNegativeMarks = input.defaultNegativeMarks));
    if (input.randomizeQuestions !== undefined)
      (this.assertEditable(isEditable, 'randomizeQuestions'),
        (update.randomizeQuestions = input.randomizeQuestions));
    if (input.randomizeOptions !== undefined)
      (this.assertEditable(isEditable, 'randomizeOptions'),
        (update.randomizeOptions = input.randomizeOptions));
    if (input.opensAt !== undefined)
      (this.assertEditable(isEditable, 'opensAt'),
        (update.opensAt = input.opensAt ? new Date(input.opensAt) : null));
    if (input.antiCheatConfig !== undefined)
      (this.assertEditable(isEditable, 'antiCheatConfig'),
        (update.antiCheatConfig = input.antiCheatConfig));

    if (input.programId !== undefined || input.subjectId !== undefined) {
      this.assertEditable(isEditable, 'taxonomy');
      await this.taxonomy.resolve(input.actor.tenantId, {
        programId: input.programId ?? undefined,
        subjectId: input.subjectId ?? undefined,
      });
      if (input.programId !== undefined) update.programId = input.programId;
      if (input.subjectId !== undefined) update.subjectId = input.subjectId;
    }

    // closesAt may be extended after publish (only later, not earlier).
    if (input.closesAt !== undefined) {
      const newClose = input.closesAt ? new Date(input.closesAt) : null;
      if (!isEditable) {
        if (!newClose || (target.closesAt && newClose.getTime() <= target.closesAt.getTime())) {
          throw new ConflictException('After publish, closesAt may only be extended later');
        }
      }
      update.closesAt = newClose;
    }

    if (Object.keys(update).length === 0) {
      throw new BadRequestException('No fields to update');
    }
    return this.exams.update(input.actor.tenantId, input.id, update);
  }

  private assertEditable(isEditable: boolean, field: string): void {
    if (!isEditable) {
      throw new ConflictException(`Field "${field}" cannot be changed after the exam is published`);
    }
  }
}
