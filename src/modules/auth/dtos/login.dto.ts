import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  // Optional: tenant slug to disambiguate when the same email exists in multiple tenants.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  tenantSlug?: string;
}
