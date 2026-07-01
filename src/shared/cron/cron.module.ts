import { Module } from '@nestjs/common';
import { AttemptsModule } from '../../modules/attempts/attempts.module';
import { AttemptsRepoModule } from '../../modules/attempts/attempts-repo.module';
import { OcrJobsRepoModule } from '../../modules/ocr/ocr-jobs-repo.module';
import { UploadsModule } from '../../modules/uploads/uploads.module';
import { AutoSubmitExpiredCron } from './auto-submit-expired.cron';
import { NotificationsDispatchCron } from './notifications-dispatch.cron';
import { OcrRecoveryService } from './ocr-recovery.service';
import { StuckUploadsCron } from './stuck-uploads.cron';
import { TransitionExamStatusCron } from './transition-exam-status.cron';
import { WorkerAbsenceCron } from './worker-absence.cron';

// OcrJobsRepoModule supplies OCR_JOB_REPOSITORY for OcrRecoveryService; OCR_DISPATCHER
// comes from the @Global() QueueModule.
@Module({
  imports: [AttemptsRepoModule, AttemptsModule, UploadsModule, OcrJobsRepoModule],
  providers: [
    AutoSubmitExpiredCron,
    TransitionExamStatusCron,
    NotificationsDispatchCron,
    StuckUploadsCron,
    OcrRecoveryService,
    WorkerAbsenceCron,
  ],
})
export class CronModule {}
