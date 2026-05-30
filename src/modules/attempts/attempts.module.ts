import { Module } from '@nestjs/common';
import { StudentsModule } from '../students/students.module';
import { AttemptsRepoModule } from './attempts-repo.module';
import { AttemptsController } from './controllers/attempts.controller';
import { MeExamsController } from './controllers/me-exams.controller';
import { GradingService } from './grading/grading.service';
import { StudentResolverService } from './services/student-resolver.service';
import { GetAttemptResultUseCase } from './use-cases/get-attempt-result.use-case';
import { GetMyAttemptUseCase } from './use-cases/get-my-attempt.use-case';
import { GetMyExamUseCase } from './use-cases/get-my-exam.use-case';
import { GradeAttemptUseCase } from './use-cases/grade-attempt.use-case';
import { HeartbeatAttemptUseCase } from './use-cases/heartbeat-attempt.use-case';
import { ListMyExamsUseCase } from './use-cases/list-my-exams.use-case';
import { StartAttemptUseCase } from './use-cases/start-attempt.use-case';
import { SubmitAttemptUseCase } from './use-cases/submit-attempt.use-case';
import { UpsertAttemptAnswerUseCase } from './use-cases/upsert-attempt-answer.use-case';

@Module({
  imports: [AttemptsRepoModule, StudentsModule],
  controllers: [MeExamsController, AttemptsController],
  providers: [
    GradingService,
    StudentResolverService,
    ListMyExamsUseCase,
    GetMyExamUseCase,
    StartAttemptUseCase,
    GetMyAttemptUseCase,
    UpsertAttemptAnswerUseCase,
    HeartbeatAttemptUseCase,
    SubmitAttemptUseCase,
    GetAttemptResultUseCase,
    GradeAttemptUseCase,
  ],
  exports: [GradeAttemptUseCase, GradingService, StudentResolverService],
})
export class AttemptsModule {}
