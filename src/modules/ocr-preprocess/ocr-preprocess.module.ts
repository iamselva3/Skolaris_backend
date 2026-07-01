import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module';
import { OcrPreprocessController } from './controllers/ocr-preprocess.controller';
import { OcrPreprocessService } from './ocr-preprocess.service';

/**
 * NEW preprocess layer (column reflow) wrapped AROUND the OCR pipeline — it does not
 * import or modify the engine / OcrJobRunner / CompleteUploadUseCase. It reuses the
 * UPLOAD_REPOSITORY (from UploadsModule) and the global OBJECT_STORAGE only.
 */
@Module({
  imports: [UploadsModule],
  controllers: [OcrPreprocessController],
  providers: [OcrPreprocessService],
})
export class OcrPreprocessModule {}
