import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Difficulty, QuestionType } from '../../questions/models/question-type.enum';

export class ApproveDraftOptionDto {
  @IsString() @MinLength(1) @MaxLength(1000) label!: string;
  @IsBoolean() isCorrect!: boolean;
}

/**
 * `correctAnswer` is intentionally a free-form object so the same DTO covers
 * every QuestionType. The use case validates its shape against the resolved
 * QuestionType using QuestionPayloadValidator.
 *
 * For choice types, the answer key is supplied via `options[].isCorrect`.
 * For other types, embed the answer in `correctAnswer` (which becomes `payload`).
 */
export class ApproveDraftDto {
  // Overrides the draft's detectedType when present.
  @IsOptional()
  @IsEnum(QuestionType)
  type?: QuestionType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  questionSnapshotKey?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApproveDraftOptionDto)
  options?: ApproveDraftOptionDto[];

  @IsOptional()
  @IsObject()
  correctAnswer?: Record<string, unknown>;

  @IsOptional() @IsUUID() programId?: string;
  @IsOptional() @IsUUID() subjectId?: string;
  @IsOptional() @IsUUID() topicId?: string;
  @IsOptional() @IsUUID() chapterId?: string;

  @IsOptional() @IsString() @MaxLength(80) subject?: string;
  @IsOptional() @IsString() @MaxLength(80) topic?: string;
  @IsOptional() @IsEnum(Difficulty) difficulty?: Difficulty;
}
