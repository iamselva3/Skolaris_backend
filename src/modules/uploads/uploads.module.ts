import { Module } from '@nestjs/common';
import { OcrJobsRepoModule } from '../ocr/ocr-jobs-repo.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { UploadsController } from './controllers/uploads.controller';
import { PrismaUploadRepository } from './repositories/prisma-upload.repository';
import { UPLOAD_REPOSITORY } from './repositories/upload.repository';
import { CompleteUploadUseCase } from './use-cases/complete-upload.use-case';
import { CreateUploadUseCase } from './use-cases/create-upload.use-case';
import { DeleteUploadUseCase } from './use-cases/delete-upload.use-case';
import { GetUploadUseCase } from './use-cases/get-upload.use-case';
import { ListUploadsUseCase } from './use-cases/list-uploads.use-case';

@Module({
  imports: [OcrJobsRepoModule, TaxonomyModule],
  controllers: [UploadsController],
  providers: [
    CreateUploadUseCase,
    CompleteUploadUseCase,
    ListUploadsUseCase,
    GetUploadUseCase,
    DeleteUploadUseCase,
    { provide: UPLOAD_REPOSITORY, useClass: PrismaUploadRepository },
  ],
  // CompleteUploadUseCase is exported so the OCR batch orchestrator can reuse the
  // single-file complete/dispatch path verbatim (no OCR-pipeline changes).
  exports: [UPLOAD_REPOSITORY, CompleteUploadUseCase],
})
export class UploadsModule {}
