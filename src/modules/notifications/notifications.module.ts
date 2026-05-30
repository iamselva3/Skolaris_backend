import { Module } from '@nestjs/common';
import { NOTIFICATION_REPOSITORY } from './repositories/notification.repository';
import { PrismaNotificationRepository } from './repositories/prisma-notification.repository';
import { CreateNotificationUseCase } from './use-cases/create-notification.use-case';
import { DispatchPendingNotificationsUseCase } from './use-cases/dispatch-pending-notifications.use-case';
import { ListNotificationsForUserUseCase } from './use-cases/list-notifications.use-case';
import { MarkNotificationReadUseCase } from './use-cases/mark-notification-read.use-case';

import { DeleteNotificationUseCase } from './use-cases/delete-notification.use-case';

@Module({
  providers: [
    CreateNotificationUseCase,
    DispatchPendingNotificationsUseCase,
    ListNotificationsForUserUseCase,
    MarkNotificationReadUseCase,
    DeleteNotificationUseCase,
    { provide: NOTIFICATION_REPOSITORY, useClass: PrismaNotificationRepository },
  ],
  exports: [
    CreateNotificationUseCase,
    DispatchPendingNotificationsUseCase,
    ListNotificationsForUserUseCase,
    MarkNotificationReadUseCase,
    DeleteNotificationUseCase,
    NOTIFICATION_REPOSITORY,
  ],
})
export class NotificationsModule {}
