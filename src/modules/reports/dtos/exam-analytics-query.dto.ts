import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ExamStudentsQueryDto {
  @IsOptional() @IsString() @MaxLength(120) q?: string;

  @IsOptional() @IsIn(['ATTENDED', 'ABSENT']) status?: 'ATTENDED' | 'ABSENT';

  @IsOptional()
  @IsIn(['rank', 'name', 'totalScore', 'accuracy', 'negativeMarks', 'totalTime'])
  sort?: 'rank' | 'name' | 'totalScore' | 'accuracy' | 'negativeMarks' | 'totalTime';

  @IsOptional() @IsIn(['asc', 'desc']) dir?: 'asc' | 'desc';

  @IsOptional() @IsInt() @Min(1) @Max(1000) @Type(() => Number) limit?: number;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) offset?: number;

  @IsOptional() @IsString() discipline?: string;
  @IsOptional() @IsString() batch?: string;
  @IsOptional() @IsString() section?: string;
}

export class ExamHeatmapQueryDto {
  @IsOptional() @IsInt() @Min(1) @Max(1000) @Type(() => Number) limit?: number;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) offset?: number;
}
