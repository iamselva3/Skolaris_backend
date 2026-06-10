import { AssignedTaxonomy, OcrDraftModel, SuggestedAnswer } from '../models/ocr-draft.model';
import { OcrJobModel } from '../models/ocr-job.model';

export interface OcrJobResponse {
  id: string;
  tenantId: string;
  uploadId: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  overallConfidence: number | null;
  providerUsed: string | null;
  errorMessage: string | null;
  draftCounts: Record<string, number>;
}

export interface OcrDraftResponse {
  id: string;
  ocrJobId: string;
  position: number;
  text: string;
  detectedType: string | null;
  options: unknown;
  confidence: number | null;
  status: string;
  approvedQuestionId: string | null;
  questionSnapshotKey: string | null;
  optionCount: number | null;
  /** Detected question number + invalid-crop flag (Question Navigator). */
  questionNumber: number | null;
  invalidCrop: boolean | null;
  sourceCoordinates: Record<string, number> | null;
  /** Pre-filled answer from an imported answer key; FE pre-selects it. */
  suggestedAnswer: SuggestedAnswer | null;
  /** Bulk-assigned taxonomy defaults; FE pre-fills the taxonomy selectors. */
  assignedTaxonomy: AssignedTaxonomy;
  createdAt: string;
  updatedAt: string;
}

export const toOcrJobResponse = (
  job: OcrJobModel,
  draftCounts: Record<string, number>,
): OcrJobResponse => ({
  id: job.id,
  tenantId: job.tenantId,
  uploadId: job.uploadId,
  queuedAt: job.queuedAt.toISOString(),
  startedAt: job.startedAt?.toISOString() ?? null,
  finishedAt: job.finishedAt?.toISOString() ?? null,
  overallConfidence: job.overallConfidence ? Number(job.overallConfidence) : null,
  providerUsed: job.providerUsed,
  errorMessage: job.errorMessage,
  draftCounts,
});

export const toOcrDraftResponse = (d: OcrDraftModel): OcrDraftResponse => ({
  id: d.id,
  ocrJobId: d.ocrJobId,
  position: d.position,
  text: d.text,
  detectedType: d.detectedType,
  options: d.options,
  confidence: d.confidence ? Number(d.confidence) : null,
  status: d.status,
  approvedQuestionId: d.approvedQuestionId,
  questionSnapshotKey: d.questionSnapshotKey ?? null,
  optionCount: d.optionCount ?? null,
  questionNumber: d.questionNumber ?? null,
  invalidCrop: d.invalidCrop ?? null,
  sourceCoordinates: d.sourceCoordinates ?? null,
  suggestedAnswer: d.suggestedAnswer ?? null,
  assignedTaxonomy: d.assignedTaxonomy ?? {},
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
});
