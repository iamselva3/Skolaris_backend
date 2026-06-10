import { IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../../shared/common/dtos/pagination-query.dto';

export class ListClassroomsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  teacherId?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  section?: string;

  @IsOptional()
  @IsString()
  year?: string;

  @IsOptional()
  @IsString()
  subject?: string;

  @IsOptional()
  @IsString()
  search?: string;
}
