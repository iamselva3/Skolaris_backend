/**
 * Deep, EXAM-SPECIFIC analytics (the /reports/exams/:id dashboard) — distinct
 * from the cross-exam question analytics behind /reports/questions. All marks
 * are resolved through the single source of truth
 * (`exams/scoring/effective-marks.ts`); correctness/time/score read STORED
 * graded values (AttemptAnswer.isCorrect / marksAwarded / timeSpentSeconds,
 * ExamAttempt.score) — no new scoring math.
 */

export const EXAM_ANALYTICS_REPOSITORY = Symbol('EXAM_ANALYTICS_REPOSITORY');

export type QuestionClassification = 'easy' | 'normal' | 'difficult' | 'critical';

/** Topic/Chapter difficulty indicator: Easy >80% accuracy, Medium 50–80%, Difficult <50%. */
export type GroupDifficulty = 'Easy' | 'Medium' | 'Difficult';

export interface ExamAnalyticsHeader {
  examId: string;
  title: string;
  program: string | null;
  subject: string | null;
  status: string;
  totalMarks: number;
  totalQuestions: number;
  /** True when exam-level marks override per-question marks (display hint). */
  examLevelMarks: boolean;
  createdBy: string;
}

export interface ExamStudentSummary {
  totalStudents: number; // distinct assigned (individual + classroom members)
  attended: number; // distinct students with a submitted/graded/flagged attempt
  absent: number;
  avgScore: number; // mean attempt.score (points)
  highestScore: number;
  lowestScore: number;
  avgAccuracyPercent: number; // mean per-student correct/answered
  avgCompletionSeconds: number; // mean per-student total time-on-task
  avgNegativeMarks: number; // mean per-student total negative marks (magnitude)
  totalMarks: number;
}

export interface ExamQuestionAnalyticsRow {
  examQuestionId: string;
  questionId: string;
  number: number;
  stem: string;
  imageUrl: string | null;
  type: string;
  difficulty: string;
  subject: string | null;
  chapter: string | null;
  topic: string | null;
  attempted: number; // answered = correct + wrong
  correct: number;
  wrong: number;
  unanswered: number;
  correctPercent: number;
  wrongPercent: number;
  unansweredPercent: number;
  avgTimeSeconds: number;
  marks: number; // effective (resolver)
  negativeMarks: number; // effective (resolver)
  classification: QuestionClassification;
}

/** Topic / Chapter / Subject rollups share this shape. */
export interface ExamGroupRow {
  name: string;
  questionsCount: number; // total questions in this group
  attempted: number; // total answered cells (correct + wrong) across participants
  correct: number;
  wrong: number;
  unanswered: number;
  correctPercent: number;
  wrongPercent: number;
  unansweredPercent: number;
  avgAccuracyPercent: number; // correct / answered
  avgScorePercent: number; // marks awarded / max marks for the group, as %
  avgMarks: number; // average marks awarded per answered question
  avgTimeSeconds: number;
  difficulty: GroupDifficulty; // Easy/Medium/Difficult by avgAccuracyPercent
  weaknessScore: number; // 100 − avgAccuracy
  weaknessBand: 'High' | 'Medium' | 'Low';
}

export interface ExamDeepAnalytics {
  header: ExamAnalyticsHeader;
  summary: ExamStudentSummary;
  questions: ExamQuestionAnalyticsRow[];
  topics: ExamGroupRow[];
  chapters: ExamGroupRow[];
  subjects: ExamGroupRow[];
}

export interface ExamStudentRow {
  studentId: string;
  name: string;
  rollNo: string | null;
  // Attribution via the classroom THIS exam was assigned through (null if assigned
  // individually / no classroom). discipline = subject, batch = name, section.
  discipline: string | null;
  batch: string | null;
  section: string | null;
  totalScore: number;
  scorePercent: number; // score / totalMarks
  completionPercent: number; // answered / totalQuestions
  correct: number;
  wrong: number;
  unanswered: number;
  accuracyPercent: number;
  negativeMarks: number; // magnitude
  totalTimeSeconds: number;
  rank: number | null; // null for absent
  status: string; // GRADED | SUBMITTED | FLAGGED | ABSENT
}

export interface ExamStudentsPage {
  data: ExamStudentRow[];
  total: number;
  attended: number;
  filters: {
    disciplines: string[];
    batches: string[];
    sections: string[];
  };
}

export interface ExamStudentsQuery {
  q?: string;
  status?: 'ATTENDED' | 'ABSENT';
  sort?: 'rank' | 'name' | 'totalScore' | 'completion' | 'accuracy' | 'negativeMarks' | 'totalTime';
  dir?: 'asc' | 'desc';
  limit: number;
  offset: number;
  discipline?: string;
  batch?: string;
  section?: string;
}

export interface ExamStudentBreakdown {
  student: { id: string; name: string; rollNo: string | null };
  totalScore: number;
  // Per-student summary (drives the enhanced single-student PDF).
  summary: {
    rank: number | null;
    status: string;
    scorePercent: number;
    completionPercent: number;
    accuracyPercent: number;
    totalTimeSeconds: number;
    correct: number;
    wrong: number;
    unanswered: number;
    negativeMarks: number;
    discipline: string | null;
    batch: string | null;
    section: string | null;
  };
  questions: Array<{
    number: number;
    stem: string;
    topic: string | null;
    chapter: string | null;
    status: 'correct' | 'wrong' | 'unanswered';
    marksAwarded: number;
  }>;
}

export interface ExamHeatmap {
  questions: Array<{ examQuestionId: string; number: number }>;
  /** cells: index-aligned with `questions`; 0 = unanswered, 1 = correct, 2 = wrong. */
  students: Array<{ studentId: string; name: string; cells: number[] }>;
  total: number; // total attendees (for pagination)
}

export interface IExamAnalyticsRepository {
  getDeepAnalytics(tenantId: string, examId: string): Promise<ExamDeepAnalytics | null>;
  getStudents(tenantId: string, examId: string, query: ExamStudentsQuery): Promise<ExamStudentsPage>;
  getStudentBreakdown(
    tenantId: string,
    examId: string,
    studentId: string,
  ): Promise<ExamStudentBreakdown | null>;
  getHeatmap(
    tenantId: string,
    examId: string,
    limit: number,
    offset: number,
  ): Promise<ExamHeatmap>;
  /** Lightweight header read used for ownership checks before heavy aggregation. */
  getHeader(tenantId: string, examId: string): Promise<ExamAnalyticsHeader | null>;
}
