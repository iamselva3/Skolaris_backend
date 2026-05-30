import { Module } from '@nestjs/common';
import { EXAM_ATTEMPT_REPOSITORY } from './repositories/exam-attempt.repository';
import { PrismaExamAttemptRepository } from './repositories/prisma-exam-attempt.repository';

/**
 * Shared module exporting only the EXAM_ATTEMPT_REPOSITORY token, so both
 * ExamsModule (for publish + list-attempts + close + regrade) and AttemptsModule
 * (for student-side lifecycle) can depend on it without a circular import.
 */
@Module({
  providers: [{ provide: EXAM_ATTEMPT_REPOSITORY, useClass: PrismaExamAttemptRepository }],
  exports: [EXAM_ATTEMPT_REPOSITORY],
})
export class AttemptsRepoModule {}
