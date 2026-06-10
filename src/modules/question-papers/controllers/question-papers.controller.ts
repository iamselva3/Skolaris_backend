import {
  Body,
  Controller,
  Delete,
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
import { Role } from '../../../shared/common/enums/role.enum';
import {
  AddPaperQuestionsDto,
  CreateQuestionPaperDto,
  GeneratePaperDto,
  ListQuestionPapersQueryDto,
  ReorderPaperQuestionsDto,
  UpdateQuestionPaperDto,
} from '../dtos/question-paper.dtos';
import {
  QuestionPaperDetailResponse,
  QuestionPaperResponse,
  toPaperDetailResponse,
  toPaperResponse,
} from '../dtos/question-paper-response';
import { PaperSummary } from '../repositories/question-paper.repository';
import {
  ArchiveQuestionPaperUseCase,
  CloneQuestionPaperUseCase,
  CreateQuestionPaperUseCase,
  DeleteQuestionPaperUseCase,
  GetQuestionPaperUseCase,
  GetQuestionPapersSummaryUseCase,
  ListQuestionPapersUseCase,
  ManagePaperQuestionsUseCase,
  UpdateQuestionPaperUseCase,
} from '../use-cases/question-paper.use-cases';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN, Role.TEACHER)
@Controller('question-papers')
export class QuestionPapersController {
  constructor(
    private readonly createUC: CreateQuestionPaperUseCase,
    private readonly listUC: ListQuestionPapersUseCase,
    private readonly summaryUC: GetQuestionPapersSummaryUseCase,
    private readonly getUC: GetQuestionPaperUseCase,
    private readonly updateUC: UpdateQuestionPaperUseCase,
    private readonly deleteUC: DeleteQuestionPaperUseCase,
    private readonly cloneUC: CloneQuestionPaperUseCase,
    private readonly archiveUC: ArchiveQuestionPaperUseCase,
    private readonly questionsUC: ManagePaperQuestionsUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateQuestionPaperDto,
  ): Promise<{ data: QuestionPaperResponse }> {
    const r = await this.createUC.execute({ actor, ...dto });
    return { data: toPaperResponse(r) };
  }

  @Get()
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListQuestionPapersQueryDto,
  ): Promise<PaginatedResponse<QuestionPaperResponse>> {
    const r = await this.listUC.execute({
      actor,
      status: query.status,
      programId: query.programId,
      subjectId: query.subjectId,
      q: query.q,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
    return { data: r.data.map(toPaperResponse), meta: r.meta };
  }

  @Get('summary')
  async summary(@CurrentUser() actor: AuthenticatedUser): Promise<{ data: PaperSummary }> {
    return { data: await this.summaryUC.execute(actor) };
  }

  @Get(':id')
  async get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ data: QuestionPaperDetailResponse }> {
    return { data: toPaperDetailResponse(await this.getUC.execute(actor, id)) };
  }

  @Patch(':id')
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateQuestionPaperDto,
  ): Promise<{ data: QuestionPaperResponse }> {
    return { data: toPaperResponse(await this.updateUC.execute(actor, id, dto)) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.deleteUC.execute(actor, id);
  }

  @Post(':id/clone')
  @HttpCode(HttpStatus.CREATED)
  async clone(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ data: QuestionPaperResponse }> {
    return { data: toPaperResponse(await this.cloneUC.execute(actor, id)) };
  }

  @Post(':id/archive')
  async archive(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ data: QuestionPaperResponse }> {
    return { data: toPaperResponse(await this.archiveUC.execute(actor, id, true)) };
  }

  @Post(':id/unarchive')
  async unarchive(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ data: QuestionPaperResponse }> {
    return { data: toPaperResponse(await this.archiveUC.execute(actor, id, false)) };
  }

  @Post(':id/questions')
  async addQuestions(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AddPaperQuestionsDto,
  ): Promise<{ data: QuestionPaperResponse }> {
    return { data: toPaperResponse(await this.questionsUC.add(actor, id, dto.items)) };
  }

  @Patch(':id/questions/reorder')
  async reorder(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReorderPaperQuestionsDto,
  ): Promise<{ data: QuestionPaperDetailResponse }> {
    return { data: toPaperDetailResponse(await this.questionsUC.reorder(actor, id, dto.order)) };
  }

  @Delete(':id/questions/:questionId')
  async removeQuestion(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('questionId', new ParseUUIDPipe()) questionId: string,
  ): Promise<{ data: QuestionPaperResponse }> {
    return { data: toPaperResponse(await this.questionsUC.remove(actor, id, questionId)) };
  }

  @Post(':id/generate')
  async generate(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: GeneratePaperDto,
  ): Promise<{ data: QuestionPaperResponse }> {
    return { data: toPaperResponse(await this.questionsUC.generate(actor, id, dto.rules)) };
  }
}
