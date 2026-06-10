import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  Matches,
} from 'class-validator';
import { Role } from '../../../shared/common/enums/role.enum';

export class CreateUserDto {
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

  @IsEnum(Role)
  role!: Role;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @Matches(/^\d{10}$/, { message: 'Phone must be exactly 10 digits' })
  phone?: string;
}
