import { forwardRef, Module } from '@nestjs/common';
import { AttemptsModule } from '../attempts/attempts.module';
import { AttemptsRepoModule } from '../attempts/attempts-repo.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { ViolationsRepoModule } from '../violations/violations-repo.module';
import { ExamsController } from './controllers/exams.controller';
import { PrismaExamRepository } from './repositories/prisma-exam.repository';
import { EXAM_REPOSITORY } from './repositories/exam.repository';
import { AddQuestionsToExamUseCase } from './use-cases/add-questions-to-exam.use-case';
import { AssignExamUseCase } from './use-cases/assign-exam.use-case';
import { CloseExamUseCase } from './use-cases/close-exam.use-case';
import { CreateExamSectionUseCase } from './use-cases/create-exam-section.use-case';
import { CreateExamUseCase } from './use-cases/create-exam.use-case';
import { DeleteExamSectionUseCase } from './use-cases/delete-exam-section.use-case';
import { DeleteExamUseCase } from './use-cases/delete-exam.use-case';
import { GetExamAttemptDetailUseCase } from './use-cases/get-exam-attempt-detail.use-case';
import { GetExamUseCase } from './use-cases/get-exam.use-case';
import { ListExamAttemptsUseCase } from './use-cases/list-exam-attempts.use-case';
import { ListExamsUseCase } from './use-cases/list-exams.use-case';
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
    TaxonomyModule,
    forwardRef(() => AttemptsModule), // for GradeAttemptUseCase (used by regrade)
  ],
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
  ],
  exports: [EXAM_REPOSITORY, PublishExamUseCase, CloseExamUseCase],
})
export class ExamsModule {}
