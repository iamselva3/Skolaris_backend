import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ocrConfig } from '../../shared/config/ocr.config';
import { NotificationsModule } from '../notifications/notifications.module';
import { QuestionsModule } from '../questions/questions.module';
import { UploadsModule } from '../uploads/uploads.module';
import { OcrCallbackController } from './controllers/ocr-callback.controller';
import { OcrController } from './controllers/ocr.controller';
import { OcrOpsController } from './controllers/ocr-ops.controller';
import { HmacAuthGuard } from './guards/hmac-auth.guard';
import { RoutingMetricsService } from './services/routing-metrics.service';
import { OcrJobsRepoModule } from './ocr-jobs-repo.module';
import { DefaultOcrProvider } from './providers/default-ocr-provider';
import { OCR_PROVIDER } from './providers/ocr-provider.interface';
import { OCR_DRAFT_REPOSITORY } from './repositories/ocr-draft.repository';
import { PrismaOcrDraftRepository } from './repositories/prisma-ocr-draft.repository';
import { ApproveOcrDraftUseCase } from './use-cases/approve-ocr-draft.use-case';
import { BulkApproveOcrDraftsUseCase } from './use-cases/bulk-approve-ocr-drafts.use-case';
import { DiscardOcrDraftUseCase } from './use-cases/discard-ocr-draft.use-case';
import { GetOcrJobUseCase } from './use-cases/get-ocr-job.use-case';
import { HandleOcrCallbackUseCase } from './use-cases/handle-ocr-callback.use-case';
import { ListOcrDraftsUseCase } from './use-cases/list-ocr-drafts.use-case';
import { UpdateOcrDraftUseCase } from './use-cases/update-ocr-draft.use-case';

@Module({
  imports: [
    ConfigModule.forFeature(ocrConfig),
    OcrJobsRepoModule,
    UploadsModule,
    QuestionsModule,
    NotificationsModule,
  ],
  controllers: [OcrController, OcrCallbackController, OcrOpsController],
  providers: [
    HmacAuthGuard,
    DefaultOcrProvider,
    { provide: OCR_PROVIDER, useExisting: DefaultOcrProvider },
    { provide: OCR_DRAFT_REPOSITORY, useClass: PrismaOcrDraftRepository },
    RoutingMetricsService,
    HandleOcrCallbackUseCase,
    GetOcrJobUseCase,
    ListOcrDraftsUseCase,
    UpdateOcrDraftUseCase,
    ApproveOcrDraftUseCase,
    DiscardOcrDraftUseCase,
    BulkApproveOcrDraftsUseCase,
  ],
  exports: [HmacAuthGuard, OCR_DRAFT_REPOSITORY, HandleOcrCallbackUseCase, RoutingMetricsService],
})
export class OcrModule {}
