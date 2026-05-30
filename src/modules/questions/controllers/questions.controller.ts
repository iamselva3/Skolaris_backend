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
import { CreateQuestionDto } from '../dtos/create-question.dto';
import { ListQuestionsQueryDto } from '../dtos/list-questions-query.dto';
import {
  QuestionResponse,
  toQuestionResponse,
} from '../dtos/question-response.dto';
import { UpdateQuestionDto } from '../dtos/update-question.dto';
import { CreateQuestionUseCase } from '../use-cases/create-question.use-case';
import { DeleteQuestionUseCase } from '../use-cases/delete-question.use-case';
import { GetQuestionUseCase } from '../use-cases/get-question.use-case';
import { ListQuestionsUseCase } from '../use-cases/list-questions.use-case';
import { UpdateQuestionUseCase } from '../use-cases/update-question.use-case';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('questions')
export class QuestionsController {
  constructor(
    private readonly createQuestionUseCase: CreateQuestionUseCase,
    private readonly listQuestionsUseCase: ListQuestionsUseCase,
    private readonly getQuestionUseCase: GetQuestionUseCase,
    private readonly updateQuestionUseCase: UpdateQuestionUseCase,
    private readonly deleteQuestionUseCase: DeleteQuestionUseCase,
  ) {}

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateQuestionDto,
  ): Promise<{ data: QuestionResponse }> {
    const r = await this.createQuestionUseCase.execute({
      tenantId: actor.tenantId,
      createdBy: actor.sub,
      type: dto.type,
      payload: dto.payload,
      options: dto.options,
      programId: dto.programId,
      subjectId: dto.subjectId,
      topicId: dto.topicId,
      chapterId: dto.chapterId,
      subject: dto.subject,
      topic: dto.topic,
      difficulty: dto.difficulty,
    });
    return { data: toQuestionResponse(r) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get()
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListQuestionsQueryDto,
  ): Promise<PaginatedResponse<QuestionResponse>> {
    const r = await this.listQuestionsUseCase.execute({
      tenantId: actor.tenantId,
      programId: query.programId,
      subjectId: query.subjectId,
      topicId: query.topicId,
      chapterId: query.chapterId,
      subject: query.subject,
      topic: query.topic,
      difficulty: query.difficulty,
      type: query.type,
      q: query.q,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
    return { data: r.data.map(toQuestionResponse), meta: r.meta };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Get(':id')
  async get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ data: QuestionResponse }> {
    const r = await this.getQuestionUseCase.execute({ tenantId: actor.tenantId, id });
    return { data: toQuestionResponse(r) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Patch(':id')
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateQuestionDto,
  ): Promise<{ data: QuestionResponse }> {
    const r = await this.updateQuestionUseCase.execute({
      actor,
      id,
      payload: dto.payload,
      options: dto.options,
      programId: dto.programId,
      subjectId: dto.subjectId,
      topicId: dto.topicId,
      chapterId: dto.chapterId,
      subject: dto.subject,
      topic: dto.topic,
      difficulty: dto.difficulty,
      isActive: dto.isActive,
    });
    return { data: toQuestionResponse(r) };
  }

  @Roles(Role.SUPER_ADMIN, Role.TEACHER)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.deleteQuestionUseCase.execute({ actor, id });
  }
}
