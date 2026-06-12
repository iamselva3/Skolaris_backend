import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import {
  COMMUNICATION_STATUSES,
  COMMUNICATION_TYPES,
  DELIVERY_CHANNELS,
  type CommunicationStatus,
  type CommunicationType,
  type DeliveryChannel,
} from '../models/communication.model';

export class ListCommunicationsQueryDto {
  /** Free-text search over title / body / audience. */
  @IsOptional() @IsString() q?: string;

  @IsOptional() @IsIn(COMMUNICATION_TYPES) type?: CommunicationType;

  @IsOptional() @IsIn(DELIVERY_CHANNELS) channel?: DeliveryChannel;

  @IsOptional() @IsIn(COMMUNICATION_STATUSES) status?: CommunicationStatus;

  /** ISO date-time lower bound (inclusive) on sentAt. */
  @IsOptional() @IsString() dateFrom?: string;

  /** ISO date-time upper bound (inclusive) on sentAt. */
  @IsOptional() @IsString() dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 25;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
