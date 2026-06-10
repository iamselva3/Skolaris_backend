import { Decimal } from '@prisma/client/runtime/library';

export class OcrJobModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly uploadId: string,
    public readonly queuedAt: Date,
    public readonly startedAt: Date | null,
    public readonly finishedAt: Date | null,
    public readonly overallConfidence: Decimal | null,
    public readonly errorMessage: string | null,
    public readonly rawOutput: unknown,
    public readonly providerUsed: string | null,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
    /** Phase 2 — live progress JSON ({ stage, processed, total, currentPage }). */
    public readonly progress: unknown = null,
  ) {}
}
