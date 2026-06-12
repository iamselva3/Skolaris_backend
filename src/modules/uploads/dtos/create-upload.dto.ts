import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];

/**
 * Storage categories → top-level folder under `tenants/<id>/`. Whitelisted so
 * the value can be safely interpolated into the object path (no traversal).
 *  - 'uploads'         (default) generic / legacy
 *  - 'question-images' teacher-uploaded or snipped question images
 *  - 'ocr-papers'      papers fed to the OCR pipeline
 *  - 'answer-keys'     answer key images or pdfs
 */
export const UPLOAD_CATEGORIES = ['uploads', 'question-images', 'ocr-papers', 'answer-keys'] as const;
export type UploadCategory = (typeof UPLOAD_CATEGORIES)[number];

export class CreateUploadDto {
  @IsString()
  @MaxLength(255)
  @Matches(/^[^/\\]+$/, { message: 'originalName must not contain path separators' })
  originalName!: string;

  @IsString()
  @IsIn(ALLOWED_MIME, {
    message: `mimeType must be one of: ${ALLOWED_MIME.join(', ')}`,
  })
  mimeType!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(25 * 1024 * 1024)
  sizeBytes?: number;

  @IsOptional() @IsUUID() programId?: string;
  @IsOptional() @IsUUID() subjectId?: string;

  @IsOptional()
  @IsIn(UPLOAD_CATEGORIES, {
    message: `category must be one of: ${UPLOAD_CATEGORIES.join(', ')}`,
  })
  category?: UploadCategory;
}
