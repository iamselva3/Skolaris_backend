import { Type } from 'class-transformer';
import {
  ArrayMinSize,
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
import { Difficulty } from '../models/question-type.enum';
import { QuestionOptionDto } from './question-payloads';

export class UpdateQuestionDto {
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => QuestionOptionDto)
  options?: QuestionOptionDto[];

  @IsOptional() @IsUUID() programId?: string;
  @IsOptional() @IsUUID() subjectId?: string;
  @IsOptional() @IsUUID() topicId?: string;
  @IsOptional() @IsUUID() chapterId?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) subject?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) topic?: string;
  @IsOptional() @IsEnum(Difficulty) difficulty?: Difficulty;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
