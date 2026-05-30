import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { Role } from '../../../shared/common/enums/role.enum';
import { PaginationQueryDto } from '../../../shared/common/dtos/pagination-query.dto';

export class ListUsersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @IsUUID()
  branchId?: string;
}
