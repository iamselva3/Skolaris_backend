import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
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
import { QuestionPaperStatus } from '@prisma/client';

export class CreateQuestionPaperDto {
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsUUID() programId?: string;
  @IsOptional() @IsUUID() subjectId?: string;
  @IsInt() @Min(60) @Max(86_400) durationSeconds!: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) defaultNegativeMarks?: number;
}

export class UpdateQuestionPaperDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsUUID() programId?: string;
  @IsOptional() @IsUUID() subjectId?: string;
  @IsOptional() @IsInt() @Min(60) @Max(86_400) durationSeconds?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) defaultNegativeMarks?: number;
  /** Allow flipping DRAFT ↔ PUBLISHED via patch; archive uses its own endpoint. */
  @IsOptional() @IsIn(['DRAFT', 'PUBLISHED']) status?: 'DRAFT' | 'PUBLISHED';
}

export class ListQuestionPapersQueryDto {
  @IsOptional() @IsEnum(QuestionPaperStatus) status?: QuestionPaperStatus;
  @IsOptional() @IsUUID() programId?: string;
  @IsOptional() @IsUUID() subjectId?: string;
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  @IsOptional() @IsInt() @Min(1) @Max(200) @Type(() => Number) limit?: number;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) offset?: number;
}

class PaperQuestionItemDto {
  @IsUUID() questionId!: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1000) marks?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) negativeMarks?: number;
}

export class AddPaperQuestionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PaperQuestionItemDto)
  items!: PaperQuestionItemDto[];
}

class ReorderItemDto {
  @IsUUID() questionId!: string;
  @IsInt() @Min(0) position!: number;
}

export class ReorderPaperQuestionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReorderItemDto)
  order!: ReorderItemDto[];
}

class GenerateRuleDto {
  @IsOptional() @IsUUID() subjectId?: string;
  @IsOptional() @IsUUID() chapterId?: string;
  @IsOptional() @IsUUID() topicId?: string;
  @IsOptional() @IsIn(['EASY', 'MEDIUM', 'HARD']) difficulty?: 'EASY' | 'MEDIUM' | 'HARD';
  @IsInt() @Min(1) @Max(200) count!: number;
}

export class GeneratePaperDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GenerateRuleDto)
  rules!: GenerateRuleDto[];
}
