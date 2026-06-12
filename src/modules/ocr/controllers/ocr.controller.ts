import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { PaginatedResponse } from '../../../shared/common/dtos/paginated-response.dto';
import { PaginationQueryDto } from '../../../shared/common/dtos/pagination-query.dto';
import { Role } from '../../../shared/common/enums/role.enum';
import { ApproveDraftDto } from '../dtos/approve-draft.dto';
import { AssignTaxonomyDto } from '../dtos/assign-taxonomy.dto';
import { BulkApproveDraftsDto } from '../dtos/bulk-approve-drafts.dto';
import { ImportAnswerKeyDto } from '../dtos/import-answer-key.dto';
import { InsertDraftDto, MoveDraftDto } from '../dtos/insert-draft.dto';
import {
  OcrDraftResponse,
  OcrJobResponse,
  toOcrDraftResponse,
  toOcrJobResponse,
} from '../dtos/ocr-responses';
import { UpdateDraftDto } from '../dtos/update-draft.dto';
import { ApproveOcrDraftUseCase } from '../use-cases/approve-ocr-draft.use-case';
import { BulkApproveOcrDraftsUseCase } from '../use-cases/bulk-approve-ocr-drafts.use-case';
import { DiscardOcrDraftUseCase } from '../use-cases/discard-ocr-draft.use-case';
import { AssignTaxonomyResult, AssignTaxonomyUseCase } from '../use-cases/assign-taxonomy.use-case';
import {
  ImportAnswerKeyResult,
  ImportAnswerKeyUseCase,
  PreviewAnswerKeyResult,
} from '../use-cases/import-answer-key.use-case';
import type { ParseReport } from '../services/answer-key';
import { InsertOcrDraftUseCase } from '../use-cases/insert-ocr-draft.use-case';
import { ReorderOcrDraftUseCase } from '../use-cases/reorder-ocr-draft.use-case';
import { GetOcrJobUseCase } from '../use-cases/get-ocr-job.use-case';
import {
  GetOcrProgressUseCase,
  type OcrProgressSnapshot,
} from '../use-cases/get-ocr-progress.use-case';
import { ListOcrDraftsUseCase } from '../use-cases/list-ocr-drafts.use-case';
import { UpdateOcrDraftUseCase } from '../use-cases/update-ocr-draft.use-case';
import { RevertOcrDraftUseCase } from '../use-cases/revert-ocr-draft.use-case';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('ocr')
export class OcrController {
  constructor(
    private readonly getOcrJobUseCase: GetOcrJobUseCase,
    private readonly getProgressUseCase: GetOcrProgressUseCase,
    private readonly listDraftsUseCase: ListOcrDraftsUseCase,
    private readonly updateDraftUseCase: UpdateOcrDraftUseCase,
    private readonly approveDraftUseCase: ApproveOcrDraftUseCase,
    private readonly discardDraftUseCase: DiscardOcrDraftUseCase,
    private readonly bulkApproveUseCase: BulkApproveOcrDraftsUseCase,
    private readonly importAnswerKeyUseCase: ImportAnswerKeyUseCase,
    private readonly assignTaxonomyUseCase: AssignTaxonomyUseCase,
    private readonly insertDraftUseCase: InsertOcrDraftUseCase,
    private readonly reorderDraftUseCase: ReorderOcrDraftUseCase,
    private readonly revertDraftUseCase: RevertOcrDraftUseCase,
  ) {}

  /**
   * Phase 2 — live progress endpoint. Polled at ~1s by the review page while
   * the upload is still being processed; the FE stops polling when uploadStatus
   * flips to READY_FOR_REVIEW or FAILED and auto-invalidates the drafts query.
   */
  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get('progress/:uploadId')
  async getProgress(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
  ): Promise<{ data: OcrProgressSnapshot }> {
    const data = await this.getProgressUseCase.execute({
      tenantId: actor.tenantId,
      uploadId,
    });
    return { data };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get('jobs/:id')
  async getJob(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ data: OcrJobResponse }> {
    const r = await this.getOcrJobUseCase.execute({ tenantId: actor.tenantId, id });
    return { data: toOcrJobResponse(r.job, r.draftCounts) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get('jobs/:id/drafts')
  async listDrafts(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResponse<OcrDraftResponse>> {
    const r = await this.listDraftsUseCase.execute({
      tenantId: actor.tenantId,
      ocrJobId: id,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
    return { data: r.data.map(toOcrDraftResponse), meta: r.meta };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Patch('drafts/:id')
  async updateDraft(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateDraftDto,
  ): Promise<{ data: OcrDraftResponse }> {
    const r = await this.updateDraftUseCase.execute({
      tenantId: actor.tenantId,
      id,
      text: dto.text,
      detectedType: dto.detectedType,
      options: dto.options ?? undefined,
    });
    return { data: toOcrDraftResponse(r) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post('drafts/:id/approve')
  async approveDraft(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ApproveDraftDto,
  ): Promise<{ data: { draftId: string; questionId: string } }> {
    const r = await this.approveDraftUseCase.execute({
      tenantId: actor.tenantId,
      actorUserId: actor.sub,
      draftId: id,
      type: dto.type,
      options: dto.options,
      correctAnswer: dto.correctAnswer,
      programId: dto.programId,
      subjectId: dto.subjectId,
      topicId: dto.topicId,
      chapterId: dto.chapterId,
      subject: dto.subject,
      topic: dto.topic,
      difficulty: dto.difficulty,
    });
    return { data: { draftId: r.draft.id, questionId: r.question.question.id } };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post('drafts/:id/discard')
  @HttpCode(HttpStatus.OK)
  async discardDraft(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ data: OcrDraftResponse }> {
    const r = await this.discardDraftUseCase.execute({ tenantId: actor.tenantId, id });
    return { data: toOcrDraftResponse(r) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post('drafts/:id/revert')
  @HttpCode(HttpStatus.OK)
  async revertDraft(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ data: { ok: true } }> {
    await this.revertDraftUseCase.execute(actor.tenantId, id);
    return { data: { ok: true } };
  }

  /**
   * Answer-key import — map an uploaded/typed answer key ("1-A 2-C …") onto this
   * job's drafts by question number, pre-filling correct answers so the teacher
   * reviews exceptions only instead of hand-picking every answer.
   */
  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post('jobs/:id/answer-key')
  async importAnswerKey(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ImportAnswerKeyDto,
  ): Promise<{ data: ImportAnswerKeyResult }> {
    const data = await this.importAnswerKeyUseCase.execute({
      tenantId: actor.tenantId,
      ocrJobId: id,
      text: dto.text,
      storageKey: dto.storageKey,
    });
    return { data };
  }

  /**
   * Stateless answer-key PARSE — validate raw key text with the one canonical
   * grammar, no job context. Used by the multi-file batch translation so all
   * paths share a single source of truth.
   */
  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post('answer-key/parse')
  parseAnswerKey(@Body() dto: ImportAnswerKeyDto): { data: ParseReport } {
    return { data: this.importAnswerKeyUseCase.parse(dto.text ?? '') };
  }

  /**
   * Answer-key PREVIEW (dry-run) — parse + validate + (for PDF/image) OCR with
   * answer-key page selection, and return the full ParseReport WITHOUT applying.
   * The UI shows totals / missing / duplicates / invalid / pages used & ignored
   * and the parsed list; the teacher confirms before calling the apply endpoint.
   */
  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post('jobs/:id/answer-key/preview')
  async previewAnswerKey(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ImportAnswerKeyDto,
  ): Promise<{ data: PreviewAnswerKeyResult }> {
    const data = await this.importAnswerKeyUseCase.preview({
      tenantId: actor.tenantId,
      ocrJobId: id,
      text: dto.text,
      storageKey: dto.storageKey,
    });
    return { data };
  }

  /**
   * Bulk taxonomy — assign Program/Subject/Chapter/Topic + difficulty once across
   * the batch. Omit `draftIds` to apply to all drafts in the job, or pass ids to
   * apply to the selected ones. Inherited by approve unless overridden per draft.
   */
  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post('jobs/:id/taxonomy')
  async assignTaxonomy(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignTaxonomyDto,
  ): Promise<{ data: AssignTaxonomyResult }> {
    const data = await this.assignTaxonomyUseCase.execute({
      tenantId: actor.tenantId,
      ocrJobId: id,
      draftIds: dto.draftIds,
      programId: dto.programId,
      subjectId: dto.subjectId,
      topicId: dto.topicId,
      chapterId: dto.chapterId,
      difficulty: dto.difficulty,
    });
    return { data };
  }

  /**
   * Manual recovery — insert a snipped image as a new draft at a question number
   * (renumbers the rest). For "Add missing question 90 → snip → insert".
   */
  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post('jobs/:id/drafts')
  async insertDraft(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: InsertDraftDto,
  ): Promise<{ data: OcrDraftResponse }> {
    const r = await this.insertDraftUseCase.execute({
      tenantId: actor.tenantId,
      actorUserId: actor.sub,
      ocrJobId: id,
      storageKey: dto.storageKey,
      questionNumber: dto.questionNumber,
      optionCount: dto.optionCount,
      correctOption: dto.correctOption,
      solutionHtml: dto.solutionHtml,
    });
    return { data: toOcrDraftResponse(r) };
  }

  /** Manual recovery — drag-reorder a draft to a new question number. */
  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Patch('drafts/:id/move')
  async moveDraft(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: MoveDraftDto,
  ): Promise<{ data: { ok: true } }> {
    await this.reorderDraftUseCase.execute({
      tenantId: actor.tenantId,
      draftId: id,
      toQuestionNumber: dto.toQuestionNumber,
    });
    return { data: { ok: true } };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post('drafts/bulk-approve')
  async bulkApprove(@CurrentUser() actor: AuthenticatedUser, @Body() dto: BulkApproveDraftsDto) {
    const results = await this.bulkApproveUseCase.execute({
      tenantId: actor.tenantId,
      actorUserId: actor.sub,
      items: dto.items,
    });
    return { data: results };
  }
}
