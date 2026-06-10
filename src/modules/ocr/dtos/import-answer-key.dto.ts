import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Import an answer key for an OCR job. Provide EITHER `text` (pasted/typed key)
 * OR `storageKey` (an uploaded answer-key image/PDF to OCR). The use-case rejects
 * the request when both are absent.
 */
export class ImportAnswerKeyDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  text?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  storageKey?: string;
}
