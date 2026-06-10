import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../shared/common/dtos/pagination-query.dto';
import { AntiCheatConfigDto } from './exam.dtos';

export const COMPOSITION_STATUSES = ['DRAFT', 'IN_PROGRESS', 'COMPLETED'] as const;
export type CompositionStatus = (typeof COMPOSITION_STATUSES)[number];

/**
 * Filters for the Manage Question Papers list. compositionStatus is DERIVED in
 * the response (no schema column) — see computeCompositionStatus() in
 * question-paper-responses.ts. The WHERE-clause builder in the prisma adapter
 * translates this value into a SQL-friendly predicate.
 */
/**
 * Body for POST /api/question-papers. Mirrors CreateExamDto but drops the
 * delivery-only fields (opensAt, closesAt, testMode) — papers are composition
 * assets and don't carry a schedule until they're promoted to a Test.
 */
export class CreateQuestionPaperDto {
  @IsString() @IsNotEmpty() @MaxLength(160) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsInt() @Min(60) @Max(60 * 60 * 8) durationSeconds!: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) defaultNegativeMarks?: number;
  @IsOptional() @IsBoolean() randomizeQuestions?: boolean;
  @IsOptional() @IsBoolean() randomizeOptions?: boolean;
  @IsOptional() @IsUUID() programId?: string;
  @IsOptional() @IsUUID() subjectId?: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => AntiCheatConfigDto)
  antiCheatConfig?: AntiCheatConfigDto;
}

export class ListQuestionPapersQueryDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(COMPOSITION_STATUSES) compositionStatus?: CompositionStatus;
  @IsOptional() @IsUUID() createdBy?: string;
  @IsOptional() @IsUUID() programId?: string;
  @IsOptional() @IsUUID() subjectId?: string;
  /** Filter to papers assigned (via ExamAssignment) to this classroom. */
  @IsOptional() @IsUUID() classroomId?: string;
  /** Free-text contains match on Classroom.section (via ExamAssignment → Classroom). */
  @IsOptional() @IsString() @MaxLength(40) section?: string;
  @IsOptional() @IsString() @MaxLength(80) q?: string;
}
