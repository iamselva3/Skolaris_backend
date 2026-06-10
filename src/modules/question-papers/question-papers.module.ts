import { Module } from '@nestjs/common';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { QuestionPapersController } from './controllers/question-papers.controller';
import { QUESTION_PAPER_REPOSITORY } from './repositories/question-paper.repository';
import { PrismaQuestionPaperRepository } from './repositories/prisma-question-paper.repository';
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
} from './use-cases/question-paper.use-cases';

@Module({
  imports: [TaxonomyModule],
  controllers: [QuestionPapersController],
  providers: [
    { provide: QUESTION_PAPER_REPOSITORY, useClass: PrismaQuestionPaperRepository },
    CreateQuestionPaperUseCase,
    ListQuestionPapersUseCase,
    GetQuestionPapersSummaryUseCase,
    GetQuestionPaperUseCase,
    UpdateQuestionPaperUseCase,
    DeleteQuestionPaperUseCase,
    CloneQuestionPaperUseCase,
    ArchiveQuestionPaperUseCase,
    ManagePaperQuestionsUseCase,
  ],
  exports: [QUESTION_PAPER_REPOSITORY],
})
export class QuestionPapersModule {}
