import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Difficulty, QuestionType } from '../../questions/models/question-type.enum';
import { ApproveDraftOptionDto } from './approve-draft.dto';

export class BulkApproveItemDto {
  @IsUUID()
  draftId!: string;

  @IsOptional() @IsEnum(QuestionType) type?: QuestionType;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApproveDraftOptionDto)
  options?: ApproveDraftOptionDto[];

  @IsOptional() @IsObject() correctAnswer?: Record<string, unknown>;
  @IsOptional() @IsUUID() programId?: string;
  @IsOptional() @IsUUID() subjectId?: string;
  @IsOptional() @IsUUID() topicId?: string;
  @IsOptional() @IsUUID() chapterId?: string;
  @IsOptional() @IsString() @MaxLength(80) subject?: string;
  @IsOptional() @IsString() @MaxLength(80) topic?: string;
  @IsOptional() @IsEnum(Difficulty) difficulty?: Difficulty;
}

export class BulkApproveDraftsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => BulkApproveItemDto)
  items!: BulkApproveItemDto[];
}
