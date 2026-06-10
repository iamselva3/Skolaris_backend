import { ViolationModel, ViolationType } from '../models/violation.model';

export const VIOLATION_REPOSITORY = Symbol('VIOLATION_REPOSITORY');

export interface CreateViolationInput {
  tenantId: string;
  attemptId: string;
  type: ViolationType;
  detail?: Record<string, unknown> | null;
  clientTimestamp: Date;
}

export interface IViolationRepository {
  bulkCreate(input: CreateViolationInput[]): Promise<number>;
  countByAttempt(tenantId: string, attemptId: string): Promise<number>;
  countByAttemptAndType(tenantId: string, attemptId: string, type: ViolationType): Promise<number>;
  listByAttempt(tenantId: string, attemptId: string): Promise<ViolationModel[]>;
}
