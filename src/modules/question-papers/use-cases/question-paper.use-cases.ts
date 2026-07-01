import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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

/**
 * Published papers are immutable snapshots — content edits (title, questions,
 * reorder, generate) are rejected. To change a published paper, a revision
 * working copy is created instead (see ReviseQuestionPaperUseCase).
 */
const assertEditable = (paper: PaperRow): void => {
  if (paper.status === 'PUBLISHED') {
    throw new ConflictException(
      'This question paper is published and locked. Create a revision to make changes.',
    );
  }
};

const DUPLICATE_TITLE_MESSAGE = 'This question paper name already exists.';

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
    const title = input.title.trim();
    if (await this.papers.existsByTitle(input.actor.tenantId, title)) {
      throw new ConflictException(DUPLICATE_TITLE_MESSAGE);
    }
    return this.papers.create({
      tenantId: input.actor.tenantId,
      branchId: input.actor.branchId ?? null,
      createdBy: input.actor.sub,
      title,
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
    const current = await this.loadOwned(actor, id);

    // Publishing a DRAFT is allowed (and only then do we stamp publishedAt, once).
    // Any OTHER mutation of an already-published paper is rejected — it is an
    // immutable snapshot. Edits must go through a revision working copy.
    const isPublishing = patch.status === 'PUBLISHED' && current.status !== 'PUBLISHED';
    if (!isPublishing) assertEditable(current);

    const next: UpdatePaperInput = { ...patch };

    if (patch.title !== undefined) {
      next.title = patch.title.trim();
      if (await this.papers.existsByTitle(actor.tenantId, next.title, id)) {
        throw new ConflictException(DUPLICATE_TITLE_MESSAGE);
      }
    }

    // Stamp the permanent publish timestamp exactly once, on first publish.
    if (isPublishing && current.publishedAt == null) {
      next.publishedAt = new Date();
    }

    return this.papers.update(actor.tenantId, id, next);
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
    // Unarchiving must NOT turn a previously-published paper into an editable
    // draft (that would breach immutability). A paper that was ever published
    // (publishedAt set) restores to PUBLISHED; everything else restores to DRAFT.
    const restored = paper.publishedAt ? 'PUBLISHED' : 'DRAFT';
    return this.papers.update(actor.tenantId, id, {
      status: archived ? 'ARCHIVED' : restored,
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
    assertEditable(paper); // published papers are immutable — no add/remove/reorder/generate
  }
}

@Injectable()
export class ReviseQuestionPaperUseCase {
  constructor(
    @Inject(QUESTION_PAPER_REPOSITORY) private readonly papers: IQuestionPaperRepository,
  ) {}

  /**
   * Create an editable DRAFT working copy of a published paper. The original is
   * never modified; publishing the copy later creates a new version.
   */
  async execute(actor: AuthenticatedUser, id: string): Promise<PaperRow> {
    const source = await this.papers.findById(actor.tenantId, id);
    if (!source) throw new NotFoundException('Question paper not found');
    assertCanManage(source, actor);
    return this.papers.createWorkingCopy(actor.tenantId, id, actor.sub, actor.branchId ?? null);
  }
}
