import { ExamDetail } from '../repositories/exam.repository';
import { ExamModel } from '../models/exam.model';

export interface ExamResponse {
  id: string;
  tenantId: string;
  createdBy: string;
  title: string;
  description: string | null;
  durationSeconds: number;
  totalMarks: number;
  defaultNegativeMarks: number;
  randomizeQuestions: boolean;
  randomizeOptions: boolean;
  status: string;
  opensAt: string | null;
  closesAt: string | null;
  testMode: string;
  publishedAt: string | null;
  antiCheatConfig: Record<string, unknown>;
  programId: string | null;
  subjectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExamDetailResponse extends ExamResponse {
  sections: Array<{
    id: string;
    name: string;
    position: number;
    timeLimitSeconds: number | null;
  }>;
  questions: Array<{
    id: string;
    questionId: string;
    sectionId: string | null;
    position: number;
    marks: number;
    negativeMarks: number;
  }>;
  assignments: Array<{
    id: string;
    classroomId: string | null;
    studentId: string | null;
  }>;
}

export const toExamResponse = (e: ExamModel): ExamResponse => ({
  id: e.id,
  tenantId: e.tenantId,
  createdBy: e.createdBy,
  title: e.title,
  description: e.description,
  durationSeconds: e.durationSeconds,
  totalMarks: Number(e.totalMarks),
  defaultNegativeMarks: Number(e.defaultNegativeMarks),
  randomizeQuestions: e.randomizeQuestions,
  randomizeOptions: e.randomizeOptions,
  status: e.status,
  opensAt: e.opensAt?.toISOString() ?? null,
  closesAt: e.closesAt?.toISOString() ?? null,
  testMode: e.testMode,
  publishedAt: e.publishedAt?.toISOString() ?? null,
  antiCheatConfig: e.antiCheatConfig as unknown as Record<string, unknown>,
  programId: e.programId,
  subjectId: e.subjectId,
  createdAt: e.createdAt.toISOString(),
  updatedAt: e.updatedAt.toISOString(),
});

export const toExamDetailResponse = (d: ExamDetail): ExamDetailResponse => ({
  ...toExamResponse(d.exam),
  sections: d.sections.map((s) => ({
    id: s.id,
    name: s.name,
    position: s.position,
    timeLimitSeconds: s.timeLimitSeconds,
  })),
  questions: d.questions.map((q) => ({
    id: q.id,
    questionId: q.questionId,
    sectionId: q.sectionId,
    position: q.position,
    marks: Number(q.marks),
    negativeMarks: Number(q.negativeMarks),
  })),
  assignments: d.assignments.map((a) => ({
    id: a.id,
    classroomId: a.classroomId,
    studentId: a.studentId,
  })),
});
