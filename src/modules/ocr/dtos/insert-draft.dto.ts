import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/** Insert a snipped image as a new visual draft at a chosen question number. */
export class InsertDraftDto {
  @IsString() @MinLength(1) @MaxLength(1024) storageKey!: string;

  @IsInt() @Min(1) @Max(2000) questionNumber!: number;

  @IsOptional() @IsInt() @Min(0) @Max(10) optionCount?: number;

  /** 1-based correct option. When provided the draft is APPROVED immediately
   *  (a complete Visual Question — no separate OCR-review step). */
  @IsOptional() @IsInt() @Min(1) @Max(10) correctOption?: number;

  /** Optional solution/explanation shown after a student submits. */
  @IsOptional() @IsString() @MaxLength(2000) solutionHtml?: string;
}

/** Move a draft to a new question number (drag-reorder). */
export class MoveDraftDto {
  @IsInt() @Min(1) @Max(2000) toQuestionNumber!: number;
}
