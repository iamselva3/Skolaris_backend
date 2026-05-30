import { IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../../shared/common/dtos/pagination-query.dto';

export class ListClassroomsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
