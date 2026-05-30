import { Module } from '@nestjs/common';
import { PrismaViolationRepository } from './repositories/prisma-violation.repository';
import { VIOLATION_REPOSITORY } from './repositories/violation.repository';

/**
 * Shared token-only module so multiple feature modules can read violations
 * (Exams for attempt detail timeline, Violations for ingestion).
 */
@Module({
  providers: [{ provide: VIOLATION_REPOSITORY, useClass: PrismaViolationRepository }],
  exports: [VIOLATION_REPOSITORY],
})
export class ViolationsRepoModule {}
