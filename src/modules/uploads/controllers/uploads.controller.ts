import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { Role } from '../../../shared/common/enums/role.enum';
import { CreateUploadDto } from '../dtos/create-upload.dto';
import { ListUploadsQueryDto } from '../dtos/list-uploads-query.dto';
import {
  SignedUploadResponse,
  UploadResponse,
  toUploadResponse,
} from '../dtos/upload-response.dto';
import { CompleteUploadUseCase } from '../use-cases/complete-upload.use-case';
import { CreateUploadUseCase } from '../use-cases/create-upload.use-case';
import { DeleteUploadUseCase } from '../use-cases/delete-upload.use-case';
import { GetUploadUseCase } from '../use-cases/get-upload.use-case';
import { ListUploadsUseCase } from '../use-cases/list-uploads.use-case';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('uploads')
export class UploadsController {
  constructor(
    private readonly createUploadUseCase: CreateUploadUseCase,
    private readonly completeUploadUseCase: CompleteUploadUseCase,
    private readonly listUploadsUseCase: ListUploadsUseCase,
    private readonly getUploadUseCase: GetUploadUseCase,
    private readonly deleteUploadUseCase: DeleteUploadUseCase,
  ) {}

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateUploadDto,
  ): Promise<{ data: SignedUploadResponse }> {
    const { upload, signedUpload } = await this.createUploadUseCase.execute({
      tenantId: actor.tenantId,
      uploadedBy: actor.sub,
      originalName: dto.originalName,
      mimeType: dto.mimeType,
      sizeBytes: dto.sizeBytes ?? null,
      programId: dto.programId,
      subjectId: dto.subjectId,
      category: dto.category ?? null,
    });
    return {
      data: {
        ...toUploadResponse(upload),
        signedUrl: signedUpload.signedUrl,
        expiresAt: signedUpload.expiresAt.toISOString(),
        httpMethod: signedUpload.httpMethod,
        requiredHeaders: signedUpload.requiredHeaders,
      },
    };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  async complete(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ data: UploadResponse }> {
    const r = await this.completeUploadUseCase.execute({ actor, id });
    return { data: toUploadResponse(r) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get()
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListUploadsQueryDto,
  ): Promise<PaginatedResponse<UploadResponse>> {
    const r = await this.listUploadsUseCase.execute({
      tenantId: actor.tenantId,
      status: query.status,
      uploadedBy: query.uploadedBy,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
    return { data: r.data.map(toUploadResponse), meta: r.meta };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get(':id')
  async get(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    const r = await this.getUploadUseCase.execute({ tenantId: actor.tenantId, id });
    return {
      data: {
        ...toUploadResponse(r.upload),
        ocrJob: r.ocrJob
          ? {
              id: r.ocrJob.id,
              queuedAt: r.ocrJob.queuedAt.toISOString(),
              startedAt: r.ocrJob.startedAt?.toISOString() ?? null,
              finishedAt: r.ocrJob.finishedAt?.toISOString() ?? null,
              overallConfidence: r.ocrJob.overallConfidence
                ? Number(r.ocrJob.overallConfidence)
                : null,
              providerUsed: r.ocrJob.providerUsed,
              errorMessage: r.ocrJob.errorMessage,
              draftCounts: r.draftCounts,
            }
          : null,
      },
    };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.deleteUploadUseCase.execute({ actor, id });
  }
}
