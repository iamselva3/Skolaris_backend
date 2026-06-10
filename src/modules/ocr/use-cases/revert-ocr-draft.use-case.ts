import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../shared/database/prisma.service';
import { IOcrDraftRepository, OCR_DRAFT_REPOSITORY } from '../repositories/ocr-draft.repository';
import { IUploadRepository, UPLOAD_REPOSITORY } from '../../uploads/repositories/upload.repository';
import { IOcrJobRepository, OCR_JOB_REPOSITORY } from '../repositories/ocr-job.repository';

@Injectable()
export class RevertOcrDraftUseCase {
  constructor(
    @Inject(OCR_DRAFT_REPOSITORY) private readonly drafts: IOcrDraftRepository,
    @Inject(OCR_JOB_REPOSITORY) private readonly ocrJobs: IOcrJobRepository,
    @Inject(UPLOAD_REPOSITORY) private readonly uploads: IUploadRepository,
    private readonly prisma: PrismaService,
  ) {}

  async execute(tenantId: string, draftId: string): Promise<void> {
    const draft = await this.drafts.findById(tenantId, draftId);
    if (!draft) throw new NotFoundException('OCR draft not found');
    if (draft.status !== 'APPROVED') {
      throw new BadRequestException('Only approved drafts can be reverted');
    }

    const job = await this.ocrJobs.findById(tenantId, draft.ocrJobId);
    if (!job) throw new NotFoundException('OCR job not found');

    await this.prisma.$transaction(async (tx) => {
      // Delete the question that was created
      if (draft.approvedQuestionId) {
        await tx.question.delete({ where: { id: draft.approvedQuestionId } });
      }

      // Revert the draft status to EDITED and clear the approvedQuestionId
      await tx.ocrDraft.update({
        where: { id: draft.id },
        data: {
          status: 'EDITED',
          approvedQuestionId: null,
        },
      });

      // If the upload was APPROVED, revert it to READY_FOR_REVIEW
      const upload = await tx.upload.findUnique({ where: { id: job.uploadId } });
      if (upload && upload.status === 'APPROVED') {
        await tx.upload.update({
          where: { id: job.uploadId },
          data: { status: 'READY_FOR_REVIEW' },
        });
      }
    });
  }
}
