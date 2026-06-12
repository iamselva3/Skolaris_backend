import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CommunicationModel } from '../models/communication.model';
import {
  COMMUNICATION_REPOSITORY,
  ICommunicationRepository,
} from '../repositories/communication.repository';

@Injectable()
export class GetCommunicationUseCase {
  constructor(
    @Inject(COMMUNICATION_REPOSITORY) private readonly repo: ICommunicationRepository,
  ) {}

  async execute(input: { tenantId: string; id: string }): Promise<CommunicationModel> {
    const c = await this.repo.getById(input.tenantId, input.id);
    if (!c) throw new NotFoundException('Communication not found');
    return c;
  }
}
