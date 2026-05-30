import { Decimal } from '@prisma/client/runtime/library';

export type ExamStatus = 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'CLOSED';
export type TestMode = 'ONLINE' | 'OFFLINE_PRINT';

export interface AntiCheatConfig {
  requireFullscreen: boolean;
  blockCopyPaste: boolean;
  blockRightClick: boolean;
  tabSwitchThreshold: number;
  totalViolationThreshold: number;
  flagAtViolationCount: number;
}

export const DEFAULT_ANTI_CHEAT_CONFIG: AntiCheatConfig = {
  requireFullscreen: true,
  blockCopyPaste: true,
  blockRightClick: true,
  tabSwitchThreshold: 3,
  totalViolationThreshold: 10,
  flagAtViolationCount: 5,
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
  ) {}

  isEditable(): boolean {
    return this.status === 'DRAFT';
  }
}
