import { Module } from '@nestjs/common';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { QuestionsController } from './controllers/questions.controller';
import { PrismaQuestionRepository } from './repositories/prisma-question.repository';
import { QUESTION_REPOSITORY } from './repositories/question.repository';
import { QuestionPayloadValidator } from './services/question-payload-validator.service';
import { CreateQuestionUseCase } from './use-cases/create-question.use-case';
import { DeleteQuestionUseCase } from './use-cases/delete-question.use-case';
import { GetQuestionUseCase } from './use-cases/get-question.use-case';
import { ListQuestionsUseCase } from './use-cases/list-questions.use-case';
import { UpdateQuestionUseCase } from './use-cases/update-question.use-case';

@Module({
  imports: [TaxonomyModule],
  controllers: [QuestionsController],
  providers: [
    QuestionPayloadValidator,
    CreateQuestionUseCase,
    ListQuestionsUseCase,
    GetQuestionUseCase,
    UpdateQuestionUseCase,
    DeleteQuestionUseCase,
    { provide: QUESTION_REPOSITORY, useClass: PrismaQuestionRepository },
  ],
  exports: [QUESTION_REPOSITORY, CreateQuestionUseCase, QuestionPayloadValidator],
})
export class QuestionsModule {}
