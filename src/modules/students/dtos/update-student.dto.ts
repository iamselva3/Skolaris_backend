import { IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ClassroomAssignmentDto } from '../../classrooms/dtos/classroom-assignment.dto';

export class UpdateStudentDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  classLabel?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  rollNo?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  parentContact?: string | null;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ClassroomAssignmentDto)
  classroom?: ClassroomAssignmentDto;
}
