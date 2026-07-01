import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module';
import { DocumentEnhancementController } from './controllers/document-enhancement.controller';
import { DocumentEnhancementService } from './document-enhancement.service';

/**
 * NEW optional Document Enhancement layer (Phase 2) wrapped AROUND the OCR pipeline.
 * It imports NONE of the OCR engine / Page Analyzer / 8 detectors / question
 * lifecycle / validation / delivery / production bridge / ocr-preprocess. It reuses
 * the UPLOAD_REPOSITORY (from UploadsModule), the global OBJECT_STORAGE, and the
 * pure profiler engine only. It writes enhanced drafts to SEPARATE keys; the
 * original object is always preserved.
 */
@Module({
  imports: [UploadsModule],
  controllers: [DocumentEnhancementController],
  providers: [DocumentEnhancementService],
})
export class DocumentEnhancementModule {}
