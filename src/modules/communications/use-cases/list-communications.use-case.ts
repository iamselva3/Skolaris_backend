import { Inject, Injectable } from '@nestjs/common';
import { CommunicationModel } from '../models/communication.model';
import {
  COMMUNICATION_REPOSITORY,
  ICommunicationRepository,
  ListCommunicationsFilter,
} from '../repositories/communication.repository';

export interface ListCommunicationsInput extends Omit<ListCommunicationsFilter, 'dateFrom' | 'dateTo'> {
  dateFrom?: string;
  dateTo?: string;
}

@Injectable()
export class ListCommunicationsUseCase {
  constructor(
    @Inject(COMMUNICATION_REPOSITORY) private readonly repo: ICommunicationRepository,
  ) {}

  execute(
    input: ListCommunicationsInput,
  ): Promise<{ data: CommunicationModel[]; total: number }> {
    return this.repo.list({
      ...input,
      dateFrom: parseDate(input.dateFrom),
      dateTo: parseDate(input.dateTo),
    });
  }
}

function parseDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
