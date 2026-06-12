import {
  CommunicationModel,
  CommunicationStatus,
  CommunicationType,
  DeliveryChannel,
} from '../models/communication.model';

export const COMMUNICATION_REPOSITORY = Symbol('COMMUNICATION_REPOSITORY');

export interface ListCommunicationsFilter {
  tenantId: string;
  q?: string;
  type?: CommunicationType;
  channel?: DeliveryChannel;
  status?: CommunicationStatus;
  dateFrom?: Date;
  dateTo?: Date;
  limit: number;
  offset: number;
}

export interface ICommunicationRepository {
  list(filter: ListCommunicationsFilter): Promise<{ data: CommunicationModel[]; total: number }>;
  getById(tenantId: string, id: string): Promise<CommunicationModel | null>;
}
