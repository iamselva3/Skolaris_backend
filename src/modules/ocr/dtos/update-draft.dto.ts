import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { QuestionType } from '../../questions/models/question-type.enum';

class DraftOptionUpdateDto {
  @IsString() @MinLength(1) @MaxLength(2000) label!: string;
  @IsOptional() @IsBoolean() isCorrect?: boolean;
}

export class UpdateDraftDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  text?: string;

  @IsOptional()
  @IsEnum(QuestionType)
  detectedType?: QuestionType;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DraftOptionUpdateDto)
  options?: DraftOptionUpdateDto[];
}
