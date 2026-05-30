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
import { BulkApproveDraftsDto } from '../dtos/bulk-approve-drafts.dto';
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
import { GetOcrJobUseCase } from '../use-cases/get-ocr-job.use-case';
import { ListOcrDraftsUseCase } from '../use-cases/list-ocr-drafts.use-case';
import { UpdateOcrDraftUseCase } from '../use-cases/update-ocr-draft.use-case';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('ocr')
export class OcrController {
  constructor(
    private readonly getOcrJobUseCase: GetOcrJobUseCase,
    private readonly listDraftsUseCase: ListOcrDraftsUseCase,
    private readonly updateDraftUseCase: UpdateOcrDraftUseCase,
    private readonly approveDraftUseCase: ApproveOcrDraftUseCase,
    private readonly discardDraftUseCase: DiscardOcrDraftUseCase,
    private readonly bulkApproveUseCase: BulkApproveOcrDraftsUseCase,
  ) {}

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
  @Post('drafts/bulk-approve')
  async bulkApprove(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: BulkApproveDraftsDto,
  ) {
    const results = await this.bulkApproveUseCase.execute({
      tenantId: actor.tenantId,
      actorUserId: actor.sub,
      items: dto.items,
    });
    return { data: results };
  }
}
