import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateClassroomDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  year?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  section?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  subject?: string | null;
}
