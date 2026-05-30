import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateStudentDto {
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

  @IsUUID()
  branchId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  classLabel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  rollNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  parentContact?: string;
}
