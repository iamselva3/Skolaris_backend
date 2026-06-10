import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { PaginationQueryDto } from '../../../shared/common/dtos/pagination-query.dto';
import { Role } from '../../../shared/common/enums/role.enum';
import { CreateOcrBatchDto } from '../dtos/create-ocr-batch.dto';
import {
  OcrBatchDraftResponse,
  OcrBatchListItemResponse,
  toOcrBatchDraftResponse,
  toOcrBatchListItemResponse,
} from '../dtos/ocr-batch-responses';
import {
  CreateOcrBatchResult,
  CreateOcrBatchUseCase,
} from '../use-cases/create-ocr-batch.use-case';
import {
  GetOcrBatchProgressUseCase,
  OcrBatchProgressSnapshot,
} from '../use-cases/get-ocr-batch-progress.use-case';
import { ListOcrBatchDraftsUseCase } from '../use-cases/list-ocr-batch-drafts.use-case';
import { ListOcrBatchesUseCase } from '../use-cases/list-ocr-batches.use-case';

/**
 * Multi-file OCR import — orchestration ONLY. These endpoints group already-
 * uploaded files into a batch and read aggregate progress / continuous-numbered
 * drafts. They reuse the unchanged single-file OCR pipeline; single-file uploads
 * keep using POST /uploads/:id/complete exactly as before.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('ocr/batches')
export class OcrBatchController {
  constructor(
    private readonly createBatchUseCase: CreateOcrBatchUseCase,
    private readonly getProgressUseCase: GetOcrBatchProgressUseCase,
    private readonly listDraftsUseCase: ListOcrBatchDraftsUseCase,
    private readonly listBatchesUseCase: ListOcrBatchesUseCase,
  ) {}

  /** Create a batch and dispatch its files sequentially to the OCR pipeline. */
  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post()
  async createBatch(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateOcrBatchDto,
  ): Promise<{ data: CreateOcrBatchResult }> {
    const data = await this.createBatchUseCase.execute({ actor, uploadIds: dto.uploadIds });
    return { data };
  }

  /** List batches for the uploads queue — one collapsed summary row per batch. */
  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get()
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ): Promise<{ data: OcrBatchListItemResponse[]; meta: { total: number; limit: number; offset: number } }> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const r = await this.listBatchesUseCase.execute({ tenantId: actor.tenantId, limit, offset });
    return { data: r.data.map(toOcrBatchListItemResponse), meta: { total: r.total, limit, offset } };
  }

  /** Aggregate progress: total / queued / processing / completed / failed + per-file. */
  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get(':id')
  async getProgress(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ data: OcrBatchProgressSnapshot }> {
    const data = await this.getProgressUseCase.execute({ tenantId: actor.tenantId, batchId: id });
    return { data };
  }

  /** All drafts across the batch in file order, with continuous batchSequence. */
  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get(':id/drafts')
  async listDrafts(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ data: OcrBatchDraftResponse[]; meta: { total: number; batchId: string } }> {
    const r = await this.listDraftsUseCase.execute({ tenantId: actor.tenantId, batchId: id });
    const data = r.rows.map((row) =>
      toOcrBatchDraftResponse(row.draft, {
        batchSequence: row.batchSequence,
        uploadId: row.uploadId,
        fileOrder: row.fileOrder,
        sourceFileName: row.sourceFileName,
      }),
    );
    return { data, meta: { total: r.totalDrafts, batchId: r.batchId } };
  }
}
