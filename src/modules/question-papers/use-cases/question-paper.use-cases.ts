import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { Role } from '../../../shared/common/enums/role.enum';
import { TaxonomyResolverService } from '../../taxonomy/services/taxonomy-resolver.service';
import { PaginatedResponse } from '../../../shared/common/dtos/paginated-response.dto';
import {
  GenerateRule,
  IQuestionPaperRepository,
  PaperQuestionInput,
  PaperRow,
  PaperSummary,
  PaperWithQuestions,
  QUESTION_PAPER_REPOSITORY,
  UpdatePaperInput,
} from '../repositories/question-paper.repository';

/** TEACHER may only touch their own papers; SUPER_ADMIN is tenant-wide. */
const assertCanManage = (paper: PaperRow, actor: AuthenticatedUser): void => {
  if (actor.role === Role.TEACHER && paper.createdBy !== actor.sub) {
    throw new ForbiddenException('Teachers can only manage question papers they own');
  }
};

@Injectable()
export class CreateQuestionPaperUseCase {
  constructor(
    @Inject(QUESTION_PAPER_REPOSITORY) private readonly papers: IQuestionPaperRepository,
    private readonly taxonomy: TaxonomyResolverService,
  ) {}

  async execute(input: {
    actor: AuthenticatedUser;
    title: string;
    description?: string;
    programId?: string;
    subjectId?: string;
    durationSeconds: number;
    defaultNegativeMarks?: number;
  }): Promise<PaperRow> {
    await this.taxonomy.resolve(input.actor.tenantId, {
      programId: input.programId,
      subjectId: input.subjectId,
    });
    return this.papers.create({
      tenantId: input.actor.tenantId,
      branchId: input.actor.branchId ?? null,
      createdBy: input.actor.sub,
      title: input.title,
      description: input.description ?? null,
      programId: input.programId ?? null,
      subjectId: input.subjectId ?? null,
      durationSeconds: input.durationSeconds,
      defaultNegativeMarks: input.defaultNegativeMarks,
    });
  }
}

@Injectable()
export class ListQuestionPapersUseCase {
  constructor(
    @Inject(QUESTION_PAPER_REPOSITORY) private readonly papers: IQuestionPaperRepository,
  ) {}

  async execute(input: {
    actor: AuthenticatedUser;
    status?: PaperRow['status'];
    programId?: string;
    subjectId?: string;
    q?: string;
    limit: number;
    offset: number;
  }): Promise<PaginatedResponse<PaperRow>> {
    const { data, total } = await this.papers.list({
      tenantId: input.actor.tenantId,
      createdBy: input.actor.role === Role.TEACHER ? input.actor.sub : undefined,
      status: input.status,
      programId: input.programId,
      subjectId: input.subjectId,
      q: input.q,
      limit: input.limit,
      offset: input.offset,
    });
    return { data, meta: { total, limit: input.limit, offset: input.offset } };
  }
}

@Injectable()
export class GetQuestionPapersSummaryUseCase {
  constructor(
    @Inject(QUESTION_PAPER_REPOSITORY) private readonly papers: IQuestionPaperRepository,
  ) {}

  execute(actor: AuthenticatedUser): Promise<PaperSummary> {
    return this.papers.summary(actor.tenantId, actor.role === Role.TEACHER ? actor.sub : undefined);
  }
}

@Injectable()
export class GetQuestionPaperUseCase {
  constructor(
    @Inject(QUESTION_PAPER_REPOSITORY) private readonly papers: IQuestionPaperRepository,
  ) {}

  async execute(actor: AuthenticatedUser, id: string): Promise<PaperWithQuestions> {
    const detail = await this.papers.findByIdWithQuestions(actor.tenantId, id);
    if (!detail) throw new NotFoundException('Question paper not found');
    assertCanManage(detail.paper, actor);
    return detail;
  }
}

@Injectable()
export class UpdateQuestionPaperUseCase {
  constructor(
    @Inject(QUESTION_PAPER_REPOSITORY) private readonly papers: IQuestionPaperRepository,
  ) {}

  async execute(actor: AuthenticatedUser, id: string, patch: UpdatePaperInput): Promise<PaperRow> {
    await this.loadOwned(actor, id);
    return this.papers.update(actor.tenantId, id, patch);
  }

  private async loadOwned(actor: AuthenticatedUser, id: string): Promise<PaperRow> {
    const paper = await this.papers.findById(actor.tenantId, id);
    if (!paper) throw new NotFoundException('Question paper not found');
    assertCanManage(paper, actor);
    return paper;
  }
}

@Injectable()
export class DeleteQuestionPaperUseCase {
  constructor(
    @Inject(QUESTION_PAPER_REPOSITORY) private readonly papers: IQuestionPaperRepository,
  ) {}

  async execute(actor: AuthenticatedUser, id: string): Promise<void> {
    const paper = await this.papers.findById(actor.tenantId, id);
    if (!paper) throw new NotFoundException('Question paper not found');
    assertCanManage(paper, actor);
    await this.papers.delete(actor.tenantId, id);
  }
}

@Injectable()
export class CloneQuestionPaperUseCase {
  constructor(
    @Inject(QUESTION_PAPER_REPOSITORY) private readonly papers: IQuestionPaperRepository,
  ) {}

  async execute(actor: AuthenticatedUser, id: string): Promise<PaperRow> {
    const source = await this.papers.findById(actor.tenantId, id);
    if (!source) throw new NotFoundException('Question paper not found');
    assertCanManage(source, actor);
    return this.papers.clone(actor.tenantId, id, actor.sub, actor.branchId ?? null);
  }
}

@Injectable()
export class ArchiveQuestionPaperUseCase {
  constructor(
    @Inject(QUESTION_PAPER_REPOSITORY) private readonly papers: IQuestionPaperRepository,
  ) {}

  async execute(actor: AuthenticatedUser, id: string, archived: boolean): Promise<PaperRow> {
    const paper = await this.papers.findById(actor.tenantId, id);
    if (!paper) throw new NotFoundException('Question paper not found');
    assertCanManage(paper, actor);
    return this.papers.update(actor.tenantId, id, {
      status: archived ? 'ARCHIVED' : 'DRAFT',
      archivedAt: archived ? new Date() : null,
    });
  }
}

@Injectable()
export class ManagePaperQuestionsUseCase {
  constructor(
    @Inject(QUESTION_PAPER_REPOSITORY) private readonly papers: IQuestionPaperRepository,
  ) {}

  async add(actor: AuthenticatedUser, id: string, items: PaperQuestionInput[]): Promise<PaperRow> {
    await this.ensureOwned(actor, id);
    return this.papers.addQuestions(actor.tenantId, id, items);
  }

  async remove(actor: AuthenticatedUser, id: string, questionId: string): Promise<PaperRow> {
    await this.ensureOwned(actor, id);
    return this.papers.removeQuestion(actor.tenantId, id, questionId);
  }

  async reorder(
    actor: AuthenticatedUser,
    id: string,
    order: Array<{ questionId: string; position: number }>,
  ): Promise<PaperWithQuestions> {
    await this.ensureOwned(actor, id);
    await this.papers.reorder(actor.tenantId, id, order);
    return (await this.papers.findByIdWithQuestions(actor.tenantId, id))!;
  }

  async generate(actor: AuthenticatedUser, id: string, rules: GenerateRule[]): Promise<PaperRow> {
    await this.ensureOwned(actor, id);
    await this.papers.generate(actor.tenantId, id, rules);
    return (await this.papers.findById(actor.tenantId, id))!;
  }

  private async ensureOwned(actor: AuthenticatedUser, id: string): Promise<void> {
    const paper = await this.papers.findById(actor.tenantId, id);
    if (!paper) throw new NotFoundException('Question paper not found');
    assertCanManage(paper, actor);
  }
}
