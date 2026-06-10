/**
 * Multi-file OCR import batch — a pure orchestration grouping over Uploads. It
 * owns no drafts/questions; those stay on each upload's (unchanged) OcrJob. The
 * batch only records that a set of uploads were imported together so the review
 * layer can show aggregate progress and continuous (batchSequence) numbering.
 */
export class OcrBatchModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly createdBy: string,
    public readonly totalFiles: number,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}
}
