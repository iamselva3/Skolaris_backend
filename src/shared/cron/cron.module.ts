import { Module } from '@nestjs/common';
import { AttemptsModule } from '../../modules/attempts/attempts.module';
import { AttemptsRepoModule } from '../../modules/attempts/attempts-repo.module';
import { UploadsModule } from '../../modules/uploads/uploads.module';
import { AutoSubmitExpiredCron } from './auto-submit-expired.cron';
import { NotificationsDispatchCron } from './notifications-dispatch.cron';
import { StuckUploadsCron } from './stuck-uploads.cron';
import { TransitionExamStatusCron } from './transition-exam-status.cron';
import { WorkerAbsenceCron } from './worker-absence.cron';

@Module({
  imports: [AttemptsRepoModule, AttemptsModule, UploadsModule],
  providers: [
    AutoSubmitExpiredCron,
    TransitionExamStatusCron,
    NotificationsDispatchCron,
    StuckUploadsCron,
    WorkerAbsenceCron,
  ],
})
export class CronModule {}
