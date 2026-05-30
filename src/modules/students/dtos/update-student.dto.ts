import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

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
}
