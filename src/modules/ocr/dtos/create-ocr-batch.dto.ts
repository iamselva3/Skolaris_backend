import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

/**
 * Create a multi-file OCR batch from already-uploaded files. `uploadIds` is the
 * ordered list (index = processing order); each must be an existing upload in
 * status PENDING_UPLOAD. The OCR pipeline is unchanged — these are fed to it one
 * at a time.
 */
export class CreateOcrBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  uploadIds!: string[];
}
