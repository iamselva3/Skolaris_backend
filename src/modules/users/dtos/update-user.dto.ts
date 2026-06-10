import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  Matches,
  ValidateIf,
} from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string | null;

  @IsOptional()
  @IsEnum(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';

  @IsOptional()
  @ValidateIf((o) => o.phone !== null)
  @Matches(/^\d{10}$/, { message: 'Phone must be exactly 10 digits' })
  phone?: string | null;
}
