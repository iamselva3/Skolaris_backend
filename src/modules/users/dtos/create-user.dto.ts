import { Type } from 'class-transformer';
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
  ValidateNested,
} from 'class-validator';
import { Role } from '../../../shared/common/enums/role.enum';
import { ClassroomAssignmentDto } from '../../classrooms/dtos/classroom-assignment.dto';

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

  // Optional one-step classroom assignment (TEACHER only). The teacher is attached
  // to the matching classroom, which is created on the fly if it doesn't exist yet.
  @IsOptional()
  @ValidateNested()
  @Type(() => ClassroomAssignmentDto)
  classroom?: ClassroomAssignmentDto;
}
