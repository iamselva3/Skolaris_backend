import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ocrConfig } from '../../shared/config/ocr.config';
import { NotificationsModule } from '../notifications/notifications.module';
import { QuestionsModule } from '../questions/questions.module';
import { UploadsModule } from '../uploads/uploads.module';
import { OcrCallbackController } from './controllers/ocr-callback.controller';
import { OcrController } from './controllers/ocr.controller';
import { OcrBatchController } from './controllers/ocr-batch.controller';
import { OcrOpsController } from './controllers/ocr-ops.controller';
import { HmacAuthGuard } from './guards/hmac-auth.guard';
import { RoutingMetricsService } from './services/routing-metrics.service';
import { OcrJobsRepoModule } from './ocr-jobs-repo.module';
import { DefaultOcrProvider } from './providers/default-ocr-provider';
import { OCR_PROVIDER } from './providers/ocr-provider.interface';
import { OCR_DRAFT_REPOSITORY } from './repositories/ocr-draft.repository';
import { PrismaOcrDraftRepository } from './repositories/prisma-ocr-draft.repository';
import { OCR_BATCH_REPOSITORY } from './repositories/ocr-batch.repository';
import { PrismaOcrBatchRepository } from './repositories/prisma-ocr-batch.repository';
import { CreateOcrBatchUseCase } from './use-cases/create-ocr-batch.use-case';
import { GetOcrBatchProgressUseCase } from './use-cases/get-ocr-batch-progress.use-case';
import { ListOcrBatchDraftsUseCase } from './use-cases/list-ocr-batch-drafts.use-case';
import { ListOcrBatchesUseCase } from './use-cases/list-ocr-batches.use-case';
import { ApproveOcrDraftUseCase } from './use-cases/approve-ocr-draft.use-case';
import { BulkApproveOcrDraftsUseCase } from './use-cases/bulk-approve-ocr-drafts.use-case';
import { DiscardOcrDraftUseCase } from './use-cases/discard-ocr-draft.use-case';
import { GetOcrJobUseCase } from './use-cases/get-ocr-job.use-case';
import { GetOcrProgressUseCase } from './use-cases/get-ocr-progress.use-case';
import { AssignTaxonomyUseCase } from './use-cases/assign-taxonomy.use-case';
import { HandleOcrCallbackUseCase } from './use-cases/handle-ocr-callback.use-case';
import { ImportAnswerKeyUseCase } from './use-cases/import-answer-key.use-case';
import { InsertOcrDraftUseCase } from './use-cases/insert-ocr-draft.use-case';
import { ReorderOcrDraftUseCase } from './use-cases/reorder-ocr-draft.use-case';
import { ListOcrDraftsUseCase } from './use-cases/list-ocr-drafts.use-case';
import { UpdateOcrDraftUseCase } from './use-cases/update-ocr-draft.use-case';
import { RevertOcrDraftUseCase } from './use-cases/revert-ocr-draft.use-case';
import { ANSWER_KEY_OCR, EngineAnswerKeyOcr } from './ports/answer-key-ocr.port';

@Module({
  imports: [
    ConfigModule.forFeature(ocrConfig),
    OcrJobsRepoModule,
    UploadsModule,
    QuestionsModule,
    NotificationsModule,
  ],
  controllers: [OcrController, OcrBatchController, OcrCallbackController, OcrOpsController],
  providers: [
    HmacAuthGuard,
    DefaultOcrProvider,
    { provide: OCR_PROVIDER, useExisting: DefaultOcrProvider },
    { provide: OCR_DRAFT_REPOSITORY, useClass: PrismaOcrDraftRepository },
    { provide: OCR_BATCH_REPOSITORY, useClass: PrismaOcrBatchRepository },
    CreateOcrBatchUseCase,
    GetOcrBatchProgressUseCase,
    ListOcrBatchDraftsUseCase,
    ListOcrBatchesUseCase,
    RoutingMetricsService,
    HandleOcrCallbackUseCase,
    GetOcrJobUseCase,
    GetOcrProgressUseCase,
    ListOcrDraftsUseCase,
    UpdateOcrDraftUseCase,
    ApproveOcrDraftUseCase,
    DiscardOcrDraftUseCase,
    BulkApproveOcrDraftsUseCase,
    ImportAnswerKeyUseCase,
    AssignTaxonomyUseCase,
    InsertOcrDraftUseCase,
    ReorderOcrDraftUseCase,
    RevertOcrDraftUseCase,
    EngineAnswerKeyOcr,
    { provide: ANSWER_KEY_OCR, useExisting: EngineAnswerKeyOcr },
  ],
  exports: [HmacAuthGuard, OCR_DRAFT_REPOSITORY, HandleOcrCallbackUseCase, RoutingMetricsService],
})
export class OcrModule {}
