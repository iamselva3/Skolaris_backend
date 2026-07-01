import { IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../../shared/common/dtos/pagination-query.dto';

export class ListOcrBatchesQueryDto extends PaginationQueryDto {
  /** Scope to a branch (Super Admin branch picker). Omit = all branches. */
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
