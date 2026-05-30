import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Difficulty, QuestionType } from '../models/question-type.enum';
import { QuestionOptionDto } from './question-payloads';

export class CreateQuestionDto {
  @IsEnum(QuestionType)
  type!: QuestionType;

  @IsObject()
  payload!: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => QuestionOptionDto)
  options?: QuestionOptionDto[];

  // Taxonomy FKs (preferred). When supplied, subject/topic strings on the
  // row are auto-populated from Subject.name / Topic.name and the legacy
  // subject/topic body fields are ignored.
  @IsOptional() @IsUUID() programId?: string;
  @IsOptional() @IsUUID() subjectId?: string;
  @IsOptional() @IsUUID() topicId?: string;
  @IsOptional() @IsUUID() chapterId?: string;

  // Legacy free-text fallback (still accepted for backwards compat / OCR drafts).
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) subject?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) topic?: string;

  @IsOptional()
  @IsEnum(Difficulty)
  difficulty?: Difficulty;
}
