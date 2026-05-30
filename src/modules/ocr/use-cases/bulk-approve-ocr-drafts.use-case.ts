import { Inject, Injectable, Logger } from '@nestjs/common';
import { Difficulty, QuestionType } from '../../questions/models/question-type.enum';
import { ApproveOcrDraftUseCase } from './approve-ocr-draft.use-case';

export interface BulkApproveItem {
  draftId: string;
  type?: QuestionType;
  options?: { label: string; isCorrect: boolean }[];
  correctAnswer?: Record<string, unknown>;
  programId?: string;
  subjectId?: string;
  topicId?: string;
  chapterId?: string;
  subject?: string;
  topic?: string;
  difficulty?: Difficulty;
}

export interface BulkApproveResultItem {
  draftId: string;
  ok: boolean;
  questionId?: string;
  error?: string;
}

@Injectable()
export class BulkApproveOcrDraftsUseCase {
  private readonly logger = new Logger(BulkApproveOcrDraftsUseCase.name);

  constructor(@Inject(ApproveOcrDraftUseCase) private readonly approve: ApproveOcrDraftUseCase) {}

  async execute(input: {
    tenantId: string;
    actorUserId: string;
    items: BulkApproveItem[];
  }): Promise<BulkApproveResultItem[]> {
    const results: BulkApproveResultItem[] = [];
    for (const item of input.items) {
      try {
        const r = await this.approve.execute({
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          draftId: item.draftId,
          type: item.type,
          options: item.options,
          correctAnswer: item.correctAnswer,
          programId: item.programId,
          subjectId: item.subjectId,
          topicId: item.topicId,
          chapterId: item.chapterId,
          subject: item.subject,
          topic: item.topic,
          difficulty: item.difficulty,
        });
        results.push({
          draftId: item.draftId,
          ok: true,
          questionId: r.question.question.id,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Bulk-approve failed for draft ${item.draftId}: ${message}`);
        results.push({ draftId: item.draftId, ok: false, error: message });
      }
    }
    return results;
  }
}
