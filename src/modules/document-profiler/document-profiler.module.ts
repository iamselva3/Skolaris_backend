import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module';
import { DocumentProfilerController } from './controllers/document-profiler.controller';
import { DocumentProfilerService } from './document-profiler.service';

/**
 * NEW read-only Document Profiler layer (Phase 1) wrapped AROUND the OCR pipeline.
 * It does NOT import or modify the OCR engine / Page Analyzer / 8 detectors /
 * OcrJobRunner / CompleteUploadUseCase / ocr-preprocess. It reuses the
 * UPLOAD_REPOSITORY (from UploadsModule) and the global OBJECT_STORAGE only, and
 * writes nothing — it classifies digital vs scanned and returns a profile.
 */
@Module({
  imports: [UploadsModule],
  controllers: [DocumentProfilerController],
  providers: [DocumentProfilerService],
})
export class DocumentProfilerModule {}
