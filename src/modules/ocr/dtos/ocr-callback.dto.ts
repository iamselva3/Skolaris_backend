import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
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

/** Figure crop attached to a draft (Slice 2.3 — visual asset preservation). */
export class OcrCallbackDraftFigureDto {
  @IsString() @MinLength(1) @MaxLength(500) storageKey!: string;
  @IsString() @MaxLength(20) kind!: string; // 'figure' | 'table' | 'graph' | 'formula'
  @IsObject() boundingBox!: { x0: number; y0: number; x1: number; y1: number; page: number };
  @IsOptional() @IsString() @MaxLength(500) caption?: string;
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

  /** Source page (1-based) in the original PDF/image; absent for legacy callbacks. */
  @IsOptional() @IsInt() @Min(1) sourcePageNumber?: number;
  @IsOptional() @IsInt() @Min(1) spanPageStart?: number;
  @IsOptional() @IsInt() @Min(1) spanPageEnd?: number;
  @IsOptional() @IsString() @MaxLength(10000) solutionText?: string;

  /** Screenshot-first: R2 key of the cropped question-region image (the Visual
   *  Question's source of truth). Also serves as the low-confidence fallback. */
  @IsOptional() @IsString() @MaxLength(500) questionSnapshotKey?: string;

  /** Number of answer slots detected on the crop (2..6). */
  @IsOptional() @IsInt() @Min(0) @Max(10) optionCount?: number;

  /** Detected question number at the top of the crop (segmentation). */
  @IsOptional() @IsInt() @Min(1) questionNumber?: number;

  /** True when the crop has no question number/stem/marker. */
  @IsOptional() @IsBoolean() invalidCrop?: boolean;

  /** Question-region bounding box on the source page { x0, y0, x1, y1 }. */
  @IsOptional() @IsObject() sourceCoordinates?: Record<string, number>;

  /** Visual asset crops attached to this draft (Slice 2.3). */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OcrCallbackDraftFigureDto)
  figures?: OcrCallbackDraftFigureDto[];
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

  /**
   * Per-page classification results, persisted on OcrJob.pageMetadata so the
   * review UI can show which pages were instructions / OMR / answer-key etc.
   * Optional: legacy callbacks without page tracking still work.
   * Shape: Array<{ pageNum, type, confidence, wordCount, questionMarkerCount }>.
   */
  @IsOptional()
  @IsArray()
  pageMetadata?: Array<Record<string, unknown>>;
}
