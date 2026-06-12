import { Module } from '@nestjs/common';
import { CommunicationsController } from './controllers/communications.controller';
import { COMMUNICATION_REPOSITORY } from './repositories/communication.repository';
import { PrismaCommunicationRepository } from './repositories/prisma-communication.repository';
import { GetCommunicationUseCase } from './use-cases/get-communication.use-case';
import { ListCommunicationsUseCase } from './use-cases/list-communications.use-case';

@Module({
  controllers: [CommunicationsController],
  providers: [
    ListCommunicationsUseCase,
    GetCommunicationUseCase,
    { provide: COMMUNICATION_REPOSITORY, useClass: PrismaCommunicationRepository },
  ],
  exports: [ListCommunicationsUseCase, GetCommunicationUseCase, COMMUNICATION_REPOSITORY],
})
export class CommunicationsModule {}
