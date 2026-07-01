export type QuestionFlag = 'too_easy' | 'too_hard' | 'ambiguous' | 'normal';

export interface ReportsOverview {
  totalExams: number;
  liveExams: number;
  totalAttempts: number;
  avgScorePercent: number;
  totalStudents: number;
  avgAccuracyPercent: number;
  weakTopicCount: number;
  questionsTracked: number;
  classCount: number;
}

export interface ExamReportRow {
  examId: string;
  title: string;
  program: string | null;
  subject: string | null;
  status: string;
  totalQuestions: number;
  totalMarks: number;
  assignedCount: number;
  attemptCount: number;
  submittedCount: number;
  gradedCount: number;
  completionPercent: number;
  avgScorePercent: number;
  avgTimeSeconds: number;
  opensAt: string | null;
  closesAt: string | null;
}

export interface ExamReportHeader {
  examId: string;
  title: string;
  program: string | null;
  subject: string | null;
  status: string;
  totalMarks: number;
  totalQuestions: number;
}

export interface QuestionMeta {
  questionId: string;
  stem: string;
  type: string;
  difficulty: string;
  subject: string | null;
  topic: string | null;
  // First inline image in the question content (e.g. a VISUAL question's
  // snapshot). null for plain text questions. Lets reports show the actual
  // question instead of "— no text —".
  imageUrl: string | null;
  // Question creation time — used to order exam-detail rows in natural reading
  // (snip) order, since OCR-imported exams can carry reversed examQuestion.position.
  createdAt: Date;
}

export interface StudentReportRow {
  studentId: string;
  name: string;
  classLabel: string | null;
  rollNo: string | null;
  attemptsTotal: number;
  gradedCount: number;
  avgScorePercent: number;
  accuracyPercent: number;
  weakTopicCount: number;
}

export interface StudentScorePoint {
  examId: string;
  examTitle: string;
  dateIso: string | null;
  scorePercent: number;
}

export interface StudentReportDetail {
  student: { id: string; name: string; classLabel: string | null; rollNo: string | null };
  trend: StudentScorePoint[];
  totalTimeSeconds: number;
  avgTimePerQuestionSeconds: number;
  accuracyPercent: number;
}

export interface TopicRollupRow {
  subject: string;
  topic: string;
  studentsAssessed: number;
  avgScorePercent: number;
  accuracyPercent: number;
  weakStudents: number;
  weakSharePercent: number;
}

export interface QuestionReportRow {
  questionId: string;
  stem: string;
  type: string;
  difficulty: string;
  subject: string | null;
  topic: string | null;
  totalAttempts: number;
  correctAttempts: number;
  correctPercent: number;
  avgTimeSeconds: number;
  flag: QuestionFlag;
  // First inline image (VISUAL questions). null for plain text questions.
  imageUrl: string | null;
}

export interface ClassReportRow {
  classroomId: string;
  // discipline = Classroom.subject, batch = Classroom.name, section = Classroom.section.
  discipline: string | null;
  name: string;
  year: string | null;
  section: string | null;
  studentCount: number;
  examsAssigned: number;
  attemptsTotal: number;
  submittedCount: number;
  completionPercent: number;
  avgScorePercent: number;
}
