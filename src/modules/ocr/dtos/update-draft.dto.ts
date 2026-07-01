import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { QuestionType } from '../../questions/models/question-type.enum';

class DraftOptionUpdateDto {
  // Label may be EMPTY: a VISUAL/option question carries its options in the crop image, and the reviewer
  // only picks the CORRECT option number (isCorrect) — they never type option text. Enforcing a min
  // length here is exactly what raised "label must be longer than or equal to 1 characters" on edit.
  @IsString() @MaxLength(2000) label!: string;
  @IsOptional() @IsBoolean() isCorrect?: boolean;
}

export class UpdateDraftDto {
  // Text may be EMPTY: a VISUAL question's text is its crop, not a string (mirrors OcrCallbackDraftDto,
  // where min-length 1 is deliberately NOT enforced). MinLength(1) here caused the PATCH /ocr/drafts/:id
  // "text must be longer than or equal to 1 characters" Bad Request when saving an image-only question.
  @IsOptional()
  @IsString()
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
