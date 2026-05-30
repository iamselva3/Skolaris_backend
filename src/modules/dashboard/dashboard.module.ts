import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  DashboardController,
  DashboardNotificationsController,
} from './controllers/dashboard.controller';
import { GetDashboardSummaryUseCase } from './use-cases/get-dashboard-summary.use-case';

@Module({
  imports: [NotificationsModule],
  controllers: [DashboardController, DashboardNotificationsController],
  providers: [GetDashboardSummaryUseCase],
})
export class DashboardModule {}
