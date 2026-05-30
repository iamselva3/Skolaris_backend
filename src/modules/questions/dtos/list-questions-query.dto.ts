import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../shared/common/dtos/pagination-query.dto';
import { Difficulty, QuestionType } from '../models/question-type.enum';

export class ListQuestionsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() programId?: string;
  @IsOptional() @IsUUID() subjectId?: string;
  @IsOptional() @IsUUID() topicId?: string;
  @IsOptional() @IsUUID() chapterId?: string;
  @IsOptional() @IsString() @MaxLength(80) subject?: string;
  @IsOptional() @IsString() @MaxLength(80) topic?: string;
  @IsOptional() @IsEnum(Difficulty) difficulty?: Difficulty;
  @IsOptional() @IsEnum(QuestionType) type?: QuestionType;
  @IsOptional() @IsString() @MaxLength(80) q?: string;
}
