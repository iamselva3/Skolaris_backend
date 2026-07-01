import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/* ─────────────────────────── Programs ─────────────────────────── */

// Per-program default marking. Fractional values are allowed (e.g. 0.5 marks,
// 0.25 negative), so these are validated as numbers — not integers — with a
// sane non-negative range.
const MARKS_MIN = 0;
const MARKS_MAX = 1000;

export class CreateProgramDto {
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  @Matches(/^[A-Z0-9_]+$/, { message: 'code must be uppercase letters, digits, or underscores' })
  code!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(MARKS_MIN)
  @Max(MARKS_MAX)
  defaultMarks?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(MARKS_MIN)
  @Max(MARKS_MAX)
  defaultNegativeMarks?: number;
}

export class UpdateProgramDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(MARKS_MIN)
  @Max(MARKS_MAX)
  defaultMarks?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(MARKS_MIN)
  @Max(MARKS_MAX)
  defaultNegativeMarks?: number;
}

/* ─────────────────────────── Subjects ─────────────────────────── */

export class CreateSubjectDto {
  @IsUUID() programId!: string;
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
}

export class UpdateSubjectDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ListSubjectsQueryDto {
  @IsOptional() @IsUUID() programId?: string;
  @IsOptional() @IsString() isActive?: string; // '1' | '0'
}

/* ───────────────── Chapters (mid-level, child of Subject) ───────────────── */

export class CreateChapterDto {
  @IsUUID() subjectId!: string;
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) position?: number;
}

export class UpdateChapterDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) name?: string;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) position?: number;
}

export class ListChaptersQueryDto {
  @IsOptional() @IsUUID() subjectId?: string;
}

/* ───────────────── Topics (leaf, child of Chapter) ───────────────── */

export class CreateTopicDto {
  @IsUUID() chapterId!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) position?: number;
}

export class UpdateTopicDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) position?: number;
}

export class ListTopicsQueryDto {
  @IsOptional() @IsUUID() chapterId?: string;
}
