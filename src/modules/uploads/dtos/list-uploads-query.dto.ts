import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../../shared/common/dtos/pagination-query.dto';

const STATUSES = [
  'PENDING_UPLOAD',
  'UPLOADED',
  'PROCESSING',
  'READY_FOR_REVIEW',
  'APPROVED',
  'FAILED',
] as const;
type Status = (typeof STATUSES)[number];

export class ListUploadsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(STATUSES)
  status?: Status;

  @IsOptional()
  @IsUUID()
  uploadedBy?: string;
}
