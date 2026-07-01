import { Type } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ClassroomAssignmentDto } from '../../classrooms/dtos/classroom-assignment.dto';

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

  // Optional one-step classroom assignment. When provided, the student is attached
  // to the matching classroom (created on the fly if it doesn't exist yet).
  @IsOptional()
  @ValidateNested()
  @Type(() => ClassroomAssignmentDto)
  classroom?: ClassroomAssignmentDto;
}
