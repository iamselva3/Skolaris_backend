import { Type } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateTenantAdminDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}

export class CreateTenantDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'slug must contain only lowercase letters, digits, and hyphens',
  })
  slug!: string;

  @ValidateNested()
  @Type(() => CreateTenantAdminDto)
  admin!: CreateTenantAdminDto;
}
