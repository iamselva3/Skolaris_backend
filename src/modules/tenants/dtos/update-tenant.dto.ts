import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import {
  MAX_TENANT_VIOLATION_LIMIT,
  MIN_TENANT_VIOLATION_LIMIT,
} from '../models/tenant.model';

export class UpdateTenantDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsEnum(['ACTIVE', 'SUSPENDED'])
  status?: 'ACTIVE' | 'SUSPENDED';

  @IsOptional()
  @IsInt()
  @Min(MIN_TENANT_VIOLATION_LIMIT)
  @Max(MAX_TENANT_VIOLATION_LIMIT)
  examViolationLimit?: number;
}
