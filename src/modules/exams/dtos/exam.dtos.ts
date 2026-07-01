import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../shared/common/dtos/pagination-query.dto';

const EXAM_STATUSES = ['DRAFT', 'SCHEDULED', 'LIVE', 'CLOSED'] as const;
type ExamStatus = (typeof EXAM_STATUSES)[number];

export class AntiCheatConfigDto {
  @IsOptional() @IsBoolean() requireFullscreen?: boolean;
  @IsOptional() @IsBoolean() blockCopyPaste?: boolean;
  @IsOptional() @IsBoolean() blockRightClick?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100) tabSwitchThreshold?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000) totalViolationThreshold?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000) flagAtViolationCount?: number;
}

export class CreateExamDto {
  @IsString() @IsNotEmpty() @MaxLength(160) title!: string;

  @IsOptional() @IsString() @MaxLength(2000) description?: string;

  @IsInt() @Min(60) @Max(60 * 60 * 8) durationSeconds!: number; // 1 min to 8h

  @IsOptional() @IsNumber() @Min(0) @Max(100) defaultNegativeMarks?: number;

  // Exam-level marks override (all-or-nothing). Setting examMarksPerQuestion makes
  // EVERY question score these exam-wide values; omit for per-question marks.
  @IsOptional() @IsNumber() @Min(0) @Max(100) examMarksPerQuestion?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) examNegativeMarks?: number;

  @IsOptional() @IsBoolean() randomizeQuestions?: boolean;
  @IsOptional() @IsBoolean() randomizeOptions?: boolean;

  @IsOptional() @IsDateString() opensAt?: string;
  @IsOptional() @IsDateString() closesAt?: string;

  @IsOptional() @IsEnum(['ONLINE', 'OFFLINE_PRINT']) testMode?: 'ONLINE' | 'OFFLINE_PRINT';

  @IsOptional() @IsUUID() programId?: string;
  @IsOptional() @IsUUID() subjectId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AntiCheatConfigDto)
  antiCheatConfig?: AntiCheatConfigDto;
}

export class UpdateExamDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @IsOptional() @IsInt() @Min(60) @Max(60 * 60 * 8) durationSeconds?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) defaultNegativeMarks?: number;
  // Pass null to clear the exam-level override and revert to per-question marks.
  @IsOptional() @IsNumber() @Min(0) @Max(100) examMarksPerQuestion?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) examNegativeMarks?: number | null;
  @IsOptional() @IsBoolean() randomizeQuestions?: boolean;
  @IsOptional() @IsBoolean() randomizeOptions?: boolean;
  @IsOptional() @IsDateString() opensAt?: string | null;
  @IsOptional() @IsDateString() closesAt?: string | null;

  @IsOptional() @IsUUID() programId?: string;
  @IsOptional() @IsUUID() subjectId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AntiCheatConfigDto)
  antiCheatConfig?: AntiCheatConfigDto;
}

export class ListExamsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(EXAM_STATUSES) status?: ExamStatus;
  @IsOptional() @IsUUID() createdBy?: string;
  @IsOptional() @IsUUID() programId?: string;
  @IsOptional() @IsUUID() subjectId?: string;
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  /** Scope to a branch (Super Admin branch picker). Omit = all branches. */
  @IsOptional() @IsUUID() branchId?: string;
  // Classroom-hierarchy filter (via assignments): discipline = Classroom.subject,
  // batch = Classroom.name, section = Classroom.section. Empty = "All".
  @IsOptional() @IsString() @MaxLength(120) discipline?: string;
  @IsOptional() @IsString() @MaxLength(120) batch?: string;
  @IsOptional() @IsString() @MaxLength(120) section?: string;
}

export class CreateSectionDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsInt() @Min(0) position!: number;
  @IsOptional() @IsInt() @Min(60) timeLimitSeconds?: number;
}

export class UpdateSectionDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsInt() @Min(0) position?: number;
  @IsOptional() @IsInt() @Min(60) timeLimitSeconds?: number | null;
}

export class AddQuestionItemDto {
  @IsUUID() questionId!: string;
  @IsOptional() @IsUUID() sectionId?: string;
  @IsInt() @Min(0) position!: number;
  @IsNumber() @Min(0) @Max(100) marks!: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) negativeMarks?: number;
}

export class AddQuestionsToExamDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AddQuestionItemDto)
  items!: AddQuestionItemDto[];
}

export class UpdateExamQuestionDto {
  @IsOptional() @IsInt() @Min(0) position?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) marks?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) negativeMarks?: number;
  @IsOptional() @IsUUID() sectionId?: string | null;
}

export class AssignExamDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  classroomIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  studentIds?: string[];
}
