import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { PaginationQueryDto } from '../../../shared/common/dtos/pagination-query.dto';

export class ListStudentsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsString()
  batch?: string;

  @IsOptional()
  @IsString()
  section?: string;

  @IsOptional()
  @IsString()
  subject?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true')
  unallocated?: boolean;
}
