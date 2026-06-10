import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { Difficulty } from '../../questions/models/question-type.enum';

/**
 * Bulk-assign taxonomy across an OCR batch. Omit `draftIds` (or send an empty
 * array) to apply to ALL drafts in the job; send ids to apply to selected only.
 * At least one taxonomy field must be present (enforced in the use-case).
 */
export class AssignTaxonomyDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('4', { each: true })
  @Type(() => String)
  draftIds?: string[];

  @IsOptional() @IsUUID() programId?: string;
  @IsOptional() @IsUUID() subjectId?: string;
  @IsOptional() @IsUUID() topicId?: string;
  @IsOptional() @IsUUID() chapterId?: string;
  @IsOptional() @IsEnum(Difficulty) difficulty?: Difficulty;
}
