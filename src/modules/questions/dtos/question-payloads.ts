import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { QuestionType } from '../models/question-type.enum';

/* ---- Per-type payload classes ------------------------------------------------ */

// All payload DTOs accept `contentHtml` — the canonical stem rendering
// (sanitized HTML produced by the rich-text editor or by OCR text→HTML
// conversion). Without this, manual question creation 400s on every save
// because the FE always includes contentHtml in the payload.

export class SingleChoicePayloadDto {
  @IsOptional() @IsString() @MaxLength(50_000) contentHtml?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  explanation?: string;
}

export class MultipleChoicePayloadDto {
  @IsOptional() @IsString() @MaxLength(50_000) contentHtml?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  explanation?: string;
}

export class TrueFalsePayloadDto {
  @IsOptional() @IsString() @MaxLength(50_000) contentHtml?: string;

  @IsBoolean()
  correct!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  explanation?: string;
}

export class FillBlankPayloadDto {
  @IsOptional() @IsString() @MaxLength(50_000) contentHtml?: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  accepted!: string[];

  @IsBoolean()
  caseSensitive!: boolean;
}

export class MatchFollowingPairDto {
  @IsString() @MinLength(1) @MaxLength(200) left!: string;
  @IsString() @MinLength(1) @MaxLength(200) right!: string;
}

export class MatchFollowingPayloadDto {
  @IsOptional() @IsString() @MaxLength(50_000) contentHtml?: string;

  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => MatchFollowingPairDto)
  pairs!: MatchFollowingPairDto[];
}

export class MatrixMatchPayloadDto {
  @IsOptional() @IsString() @MaxLength(50_000) contentHtml?: string;

  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) rows!: string[];
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) cols!: string[];
  @IsObject() correctMap!: Record<string, string[]>;
}

export class DescriptivePayloadDto {
  @IsOptional() @IsString() @MaxLength(50_000) contentHtml?: string;

  @IsOptional() @IsString() @MaxLength(2000) rubric?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10000) maxWords?: number;
}

/* ---- DTO option (used when type is choice-based) ----------------------------- */

export class QuestionOptionDto {
  @IsString() @MinLength(1) @MaxLength(1000) label!: string;
  @IsBoolean() isCorrect!: boolean;
}

/* ---- Validators ------------------------------------------------------------- */

export interface ChoiceOptionInput {
  label: string;
  isCorrect: boolean;
}

/**
 * Returns the payload class to instantiate for a given QuestionType.
 * Used both by manual create and by the OCR approve flow.
 */
export const payloadClassFor = (type: QuestionType): unknown => {
  switch (type) {
    case QuestionType.SINGLE_CHOICE:
      return SingleChoicePayloadDto;
    case QuestionType.MULTIPLE_CHOICE:
      return MultipleChoicePayloadDto;
    case QuestionType.TRUE_FALSE:
      return TrueFalsePayloadDto;
    case QuestionType.FILL_BLANK:
      return FillBlankPayloadDto;
    case QuestionType.MATCH_FOLLOWING:
      return MatchFollowingPayloadDto;
    case QuestionType.MATRIX_MATCH:
      return MatrixMatchPayloadDto;
    case QuestionType.DESCRIPTIVE:
      return DescriptivePayloadDto;
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown question type: ${String(_exhaustive)}`);
    }
  }
};

/**
 * Number of correct options expected for choice-type questions.
 */
export const expectedCorrectCount = (
  type: QuestionType,
  options: ChoiceOptionInput[],
): { ok: true } | { ok: false; reason: string } => {
  if (type === QuestionType.SINGLE_CHOICE) {
    const c = options.filter((o) => o.isCorrect).length;
    if (c !== 1) return { ok: false, reason: 'SINGLE_CHOICE requires exactly one correct option' };
  }
  if (type === QuestionType.MULTIPLE_CHOICE) {
    const c = options.filter((o) => o.isCorrect).length;
    if (c < 1) return { ok: false, reason: 'MULTIPLE_CHOICE requires at least one correct option' };
  }
  return { ok: true };
};
