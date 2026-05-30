import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { QuestionType } from '../../questions/models/question-type.enum';

export class OcrCallbackDraftOptionDto {
  @IsString() @MinLength(1) @MaxLength(2000) label!: string;
  @IsOptional() @IsBoolean() isCorrect?: boolean;
}

export class OcrCallbackDraftDto {
  @IsInt() @Min(0) position!: number;
  @IsString() @MinLength(1) @MaxLength(10000) text!: string;

  @IsOptional()
  @IsEnum(QuestionType)
  detectedType?: QuestionType;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OcrCallbackDraftOptionDto)
  options?: OcrCallbackDraftOptionDto[];

  @IsOptional() @IsNumber() @Min(0) @Max(1) confidence?: number;
}

export class OcrCallbackDto {
  @IsUUID()
  ocrJobId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  providerUsed?: string;

  @IsOptional() @IsNumber() @Min(0) @Max(1) overallConfidence?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  errorMessage?: string;

  @IsArray()
  @ArrayMinSize(0)
  @ValidateNested({ each: true })
  @Type(() => OcrCallbackDraftDto)
  drafts!: OcrCallbackDraftDto[];
}
