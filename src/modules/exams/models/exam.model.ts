import { Decimal } from '@prisma/client/runtime/library';

export type ExamStatus = 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'CLOSED';
export type TestMode = 'ONLINE' | 'OFFLINE_PRINT';
/**
 * Composition asset (PAPER) vs delivery asset (TEST). Papers stay status=DRAFT
 * forever and cannot publish or be assigned to students — the Exam table is
 * shared but the lifecycle is enforced at the use-case layer.
 */
export type ExamKind = 'PAPER' | 'TEST';

export interface AntiCheatConfig {
  requireFullscreen: boolean;
  blockCopyPaste: boolean;
  blockRightClick: boolean;
  tabSwitchThreshold: number;
  totalViolationThreshold: number;
  flagAtViolationCount: number;
}

/**
 * Hard product rule: an attempt is auto-submitted on the 6th total anti-cheat
 * violation (any type — tab switch, window blur, fullscreen exit, copy/paste, …
 * all count toward the same total). This is the single source of truth shared by
 * the violation use-case; the frontend mirrors it as the warning denominator.
 */
export const MAX_EXAM_VIOLATIONS = 6;

export const DEFAULT_ANTI_CHEAT_CONFIG: AntiCheatConfig = {
  requireFullscreen: true,
  blockCopyPaste: true,
  blockRightClick: true,
  // Only the total-violation rule (MAX_EXAM_VIOLATIONS) governs auto-submit now.
  // The per-type tab-switch threshold and the intermediate "flag" count are
  // disabled (0) so they neither auto-submit early nor flip the attempt to
  // FLAGGED mid-way (which used to block the 6th violation from being recorded).
  tabSwitchThreshold: 0,
  totalViolationThreshold: MAX_EXAM_VIOLATIONS,
  flagAtViolationCount: 0,
};

export class ExamModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly createdBy: string,
    public readonly title: string,
    public readonly description: string | null,
    public readonly durationSeconds: number,
    public readonly totalMarks: Decimal,
    public readonly defaultNegativeMarks: Decimal,
    public readonly randomizeQuestions: boolean,
    public readonly randomizeOptions: boolean,
    public readonly status: ExamStatus,
    public readonly opensAt: Date | null,
    public readonly closesAt: Date | null,
    public readonly testMode: TestMode,
    public readonly publishedAt: Date | null,
    public readonly antiCheatConfig: AntiCheatConfig,
    public readonly programId: string | null,
    public readonly subjectId: string | null,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
    public readonly kind: ExamKind = 'TEST',
    // Exam-level marks override (all-or-nothing). null = use per-question marks.
    // See src/modules/exams/scoring/effective-marks.ts.
    public readonly examMarksPerQuestion: Decimal | null = null,
    public readonly examNegativeMarks: Decimal | null = null,
    // Provenance: the QuestionPaper this test was snapshotted from (if any).
    // `sourcePaperTitle` is only populated by queries that join the paper.
    public readonly sourcePaperId: string | null = null,
    public readonly sourcePaperTitle: string | null = null,
    // Denormalized names for list display (only populated by queries that join them).
    public readonly programName: string | null = null,
    public readonly subjectName: string | null = null,
  ) {}

  isEditable(): boolean {
    return this.status === 'DRAFT';
  }

  isPaper(): boolean {
    return this.kind === 'PAPER';
  }

  isTest(): boolean {
    return this.kind === 'TEST';
  }
}
