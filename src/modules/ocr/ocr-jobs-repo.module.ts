import { Module } from '@nestjs/common';
import { OCR_JOB_REPOSITORY } from './repositories/ocr-job.repository';
import { PrismaOcrJobRepository } from './repositories/prisma-ocr-job.repository';

/**
 * Small shared module that exports only the OCR_JOB_REPOSITORY token.
 * Imported by UploadsModule (needs job lookups + creation) and OcrModule
 * (owns the rest of the OCR domain). Splitting prevents a circular import
 * between the two larger modules.
 */
@Module({
  providers: [{ provide: OCR_JOB_REPOSITORY, useClass: PrismaOcrJobRepository }],
  exports: [OCR_JOB_REPOSITORY],
})
export class OcrJobsRepoModule {}
