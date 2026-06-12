import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AttemptsModule } from './modules/attempts/attempts.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from './modules/auth/guards/roles.guard';
import { BranchesModule } from './modules/branches/branches.module';
import { ClassroomsModule } from './modules/classrooms/classrooms.module';
import { CommunicationsModule } from './modules/communications/communications.module';
import { TaxonomyModule } from './modules/taxonomy/taxonomy.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { ExamsModule } from './modules/exams/exams.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OcrModule } from './modules/ocr/ocr.module';
import { QuestionsModule } from './modules/questions/questions.module';
import { QuestionPapersModule } from './modules/question-papers/question-papers.module';
import { ReportsModule } from './modules/reports/reports.module';
import { StudentsModule } from './modules/students/students.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { UsersModule } from './modules/users/users.module';
import { ViolationsModule } from './modules/violations/violations.module';
import { HttpExceptionFilter } from './shared/common/filters/http-exception.filter';
import { LoggingInterceptor } from './shared/common/interceptors/logging.interceptor';
import { RequestIdInterceptor } from './shared/common/interceptors/request-id.interceptor';
import { appConfig } from './shared/config/app.config';
import { authConfig } from './shared/config/auth.config';
import { databaseConfig } from './shared/config/database.config';
import { emailConfig } from './shared/config/email.config';
import { ocrConfig } from './shared/config/ocr.config';
import { queueConfig } from './shared/config/queue.config';
import { storageConfig } from './shared/config/storage.config';
import { CronModule } from './shared/cron/cron.module';
import { DatabaseModule } from './shared/database/database.module';
import { EmailModule } from './shared/email/email.module';
import { QueueModule } from './shared/queue/queue.module';
import { StorageModule } from './shared/storage/storage.module';
import { WorkersModule } from './shared/workers/workers.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        authConfig,
        databaseConfig,
        queueConfig,
        storageConfig,
        ocrConfig,
        emailConfig,
      ],
    }),
    // Phase 3: rate limiting for violation ingest (and a sane global default).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 600 }]),
    ScheduleModule.forRoot(),
    DatabaseModule,
    QueueModule,
    StorageModule,
    EmailModule,
    UsersModule,
    TenantsModule,
    BranchesModule,
    AuthModule,
    StudentsModule,
    ClassroomsModule,
    NotificationsModule,
    CommunicationsModule,
    QuestionsModule,
    UploadsModule,
    OcrModule,
    DashboardModule,
    // Phase 3
    AnalyticsModule,
    AttemptsModule,
    ExamsModule,
    QuestionPapersModule,
    ViolationsModule,
    TaxonomyModule,
    ReportsModule,
    WorkersModule,
    CronModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
