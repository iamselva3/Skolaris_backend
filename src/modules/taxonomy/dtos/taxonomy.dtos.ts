import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/* ─────────────────────────── Programs ─────────────────────────── */

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
}

export class UpdateProgramDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
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

/* ─────────────────────────── Topics ─────────────────────────── */

export class CreateTopicDto {
  @IsUUID() subjectId!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) position?: number;
}

export class UpdateTopicDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) position?: number;
}

export class ListTopicsQueryDto {
  @IsOptional() @IsUUID() subjectId?: string;
}

/* ─────────────────────────── Chapters ─────────────────────────── */

export class CreateChapterDto {
  @IsUUID() topicId!: string;
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) position?: number;
}

export class UpdateChapterDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) name?: string;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) position?: number;
}

export class ListChaptersQueryDto {
  @IsOptional() @IsUUID() topicId?: string;
}
