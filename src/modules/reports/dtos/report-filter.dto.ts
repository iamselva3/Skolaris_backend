import { IsBoolean, IsDateString, IsOptional, IsString, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { PaginationQueryDto } from '../../../shared/common/dtos/pagination-query.dto';

export class ReportFilterDto extends PaginationQueryDto {

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @IsUUID()
  programId?: string;

  @IsOptional()
  @IsUUID()
  subjectId?: string;

  @IsOptional()
  @IsUUID()
  topicId?: string;

  @IsOptional()
  @IsUUID()
  chapterId?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  classroomId?: string;

  // Classroom-hierarchy filters (denormalized strings on Classroom):
  // discipline = Classroom.subject, batch = Classroom.name, section = Classroom.section.
  @IsOptional()
  @IsString()
  discipline?: string;

  @IsOptional()
  @IsString()
  batch?: string;

  @IsOptional()
  @IsString()
  section?: string;

  // Free-text classroom discipline label (alias kept for callers passing `subject`).
  @IsOptional()
  @IsString()
  subject?: string;

  // When true, scope to rows with no classroom/branch allocation.
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  unallocated?: boolean;

  @IsOptional()
  @IsString()
  q?: string;
}
