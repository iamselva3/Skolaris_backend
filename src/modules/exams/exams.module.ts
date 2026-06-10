import { forwardRef, Module } from '@nestjs/common';
import { AttemptsModule } from '../attempts/attempts.module';
import { AttemptsRepoModule } from '../attempts/attempts-repo.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { QuestionPapersModule } from '../question-papers/question-papers.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { ViolationsRepoModule } from '../violations/violations-repo.module';
import { ExamsController } from './controllers/exams.controller';
import { PrismaExamRepository } from './repositories/prisma-exam.repository';
import { EXAM_REPOSITORY } from './repositories/exam.repository';
import { AddQuestionsToExamUseCase } from './use-cases/add-questions-to-exam.use-case';
import { AssignExamUseCase } from './use-cases/assign-exam.use-case';
import { CloneQuestionPaperUseCase } from './use-cases/clone-question-paper.use-case';
import { CloseExamUseCase } from './use-cases/close-exam.use-case';
import { CreateExamSectionUseCase } from './use-cases/create-exam-section.use-case';
import { CreateExamUseCase } from './use-cases/create-exam.use-case';
import { CreateExamFromPaperUseCase } from './use-cases/create-exam-from-paper.use-case';
import { CreateQuestionPaperUseCase } from './use-cases/create-question-paper.use-case';
import { CreateTestFromPaperUseCase } from './use-cases/create-test-from-paper.use-case';
import { DeleteExamSectionUseCase } from './use-cases/delete-exam-section.use-case';
import { DeleteExamUseCase } from './use-cases/delete-exam.use-case';
import { GetExamAttemptDetailUseCase } from './use-cases/get-exam-attempt-detail.use-case';
import { GetExamUseCase } from './use-cases/get-exam.use-case';
import { GetQuestionPapersSummaryUseCase } from './use-cases/get-question-papers-summary.use-case';
import { ListExamAttemptsUseCase } from './use-cases/list-exam-attempts.use-case';
import { ListExamsUseCase } from './use-cases/list-exams.use-case';
import { ListQuestionPapersUseCase } from './use-cases/list-question-papers.use-case';
import { PublishExamUseCase } from './use-cases/publish-exam.use-case';
import { RegradeAttemptUseCase } from './use-cases/regrade-attempt.use-case';
import { RemoveExamQuestionUseCase } from './use-cases/remove-exam-question.use-case';
import { UpdateExamQuestionUseCase } from './use-cases/update-exam-question.use-case';
import { UpdateExamSectionUseCase } from './use-cases/update-exam-section.use-case';
import { UpdateExamUseCase } from './use-cases/update-exam.use-case';

@Module({
  imports: [
    AttemptsRepoModule,
    ViolationsRepoModule,
    NotificationsModule,
    QuestionPapersModule, // for snapshotting a paper into a test (CreateExamFromPaper)
    TaxonomyModule,
    forwardRef(() => AttemptsModule), // for GradeAttemptUseCase (used by regrade)
  ],
  // The standalone QuestionPapersModule owns ALL `/question-papers` routes.
  // The legacy "paper-as-Exam" controller used to also bind here, which shadowed
  // POST /question-papers (creating an Exam) while GET /:id resolved to the
  // standalone table → 404 "Question paper not found". Unregistered to fix it.
  controllers: [ExamsController],
  providers: [
    { provide: EXAM_REPOSITORY, useClass: PrismaExamRepository },
    CreateExamUseCase,
    ListExamsUseCase,
    GetExamUseCase,
    UpdateExamUseCase,
    DeleteExamUseCase,
    CreateExamSectionUseCase,
    UpdateExamSectionUseCase,
    DeleteExamSectionUseCase,
    AddQuestionsToExamUseCase,
    UpdateExamQuestionUseCase,
    RemoveExamQuestionUseCase,
    AssignExamUseCase,
    PublishExamUseCase,
    CloseExamUseCase,
    ListExamAttemptsUseCase,
    GetExamAttemptDetailUseCase,
    RegradeAttemptUseCase,
    // Manage Question Papers (kind='PAPER' surface over Exam)
    ListQuestionPapersUseCase,
    GetQuestionPapersSummaryUseCase,
    CloneQuestionPaperUseCase,
    CreateQuestionPaperUseCase,
    CreateTestFromPaperUseCase,
    // New standalone-paper → exam snapshot.
    CreateExamFromPaperUseCase,
  ],
  exports: [EXAM_REPOSITORY, PublishExamUseCase, CloseExamUseCase],
})
export class ExamsModule {}
