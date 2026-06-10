import { Injectable } from '@nestjs/common';
import { AttemptStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/database/prisma.service';
import {
  ClassReportRow,
  ExamReportHeader,
  ExamReportRow,
  QuestionFlag,
  QuestionMeta,
  QuestionReportRow,
  ReportsOverview,
  StudentReportDetail,
  StudentReportRow,
  TopicRollupRow,
} from '../models/report.models';
import { IReportsRepository, Paged, ReportFilters } from './reports.repository';

const GRADED_STATUSES: AttemptStatus[] = ['GRADED', 'FLAGGED'];
const SUBMITTED_STATUSES: AttemptStatus[] = ['SUBMITTED', 'GRADED', 'FLAGGED'];

@Injectable()
export class PrismaReportsRepository implements IReportsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Overview (launcher KPIs)
  // ---------------------------------------------------------------------------
  async getOverview(tenantId: string, createdBy?: string): Promise<ReportsOverview> {
    const examWhere: Prisma.ExamWhereInput = { tenantId, ...(createdBy ? { createdBy } : {}) };
    const attemptWhere: Prisma.ExamAttemptWhereInput = {
      tenantId,
      ...(createdBy ? { exam: { createdBy } } : {}),
    };
    const questionStatWhere: Prisma.QuestionStatWhereInput = {
      tenantId,
      ...(createdBy ? { question: { createdBy } } : {}),
    };

    const [
      totalExams,
      liveExams,
      totalAttempts,
      gradedAttempts,
      totalStudents,
      weakTopicCount,
      questionsTracked,
      classCount,
      topicAgg,
    ] = await Promise.all([
      this.prisma.exam.count({ where: examWhere }),
      this.prisma.exam.count({ where: { ...examWhere, status: 'LIVE' } }),
      this.prisma.examAttempt.count({ where: attemptWhere }),
      this.prisma.examAttempt.findMany({
        where: { ...attemptWhere, status: { in: GRADED_STATUSES } },
        select: { score: true, exam: { select: { totalMarks: true } } },
      }),
      this.prisma.student.count({ where: { tenantId } }),
      this.prisma.topicReport.count({ where: { tenantId, isWeak: true } }),
      this.prisma.questionStat.count({ where: questionStatWhere }),
      this.prisma.classroom.count({ where: { tenantId } }),
      this.prisma.topicReport.aggregate({
        where: { tenantId },
        _sum: { correctCount: true, attemptsCount: true },
      }),
    ]);

    const avgScorePercent = avg(
      gradedAttempts.map((a) => pct(Number(a.score ?? 0), Number(a.exam.totalMarks))),
    );
    const sumCorrect = topicAgg._sum.correctCount ?? 0;
    const sumAttempts = topicAgg._sum.attemptsCount ?? 0;
    const avgAccuracyPercent = sumAttempts === 0 ? 0 : round1((sumCorrect / sumAttempts) * 100);

    return {
      totalExams,
      liveExams,
      totalAttempts,
      avgScorePercent,
      totalStudents,
      avgAccuracyPercent,
      weakTopicCount,
      questionsTracked,
      classCount,
    };
  }

  // ---------------------------------------------------------------------------
  // Exam reports
  // ---------------------------------------------------------------------------
  async listExamReports(
    tenantId: string,
    createdBy: string | undefined,
    f: ReportFilters,
  ): Promise<Paged<ExamReportRow>> {
    const where: Prisma.ExamWhereInput = {
      tenantId,
      ...(createdBy ? { createdBy } : {}),
      ...(f.programId ? { programId: f.programId } : {}),
      ...(f.subjectId ? { subjectId: f.subjectId } : {}),
      ...(f.branchId ? { creator: { branchId: f.branchId } } : {}),
      ...(f.q ? { title: { contains: f.q, mode: 'insensitive' } } : {}),
      ...this.dateRange('createdAt', f),
    };

    const [exams, total] = await Promise.all([
      this.prisma.exam.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: f.offset,
        take: f.limit,
        select: {
          id: true,
          title: true,
          status: true,
          totalMarks: true,
          opensAt: true,
          closesAt: true,
          program: { select: { name: true } },
          subject: { select: { name: true } },
          _count: { select: { questions: true, assignments: true } },
        },
      }),
      this.prisma.exam.count({ where }),
    ]);

    const examIds = exams.map((e) => e.id);
    const attempts = examIds.length
      ? await this.prisma.examAttempt.findMany({
          where: { tenantId, examId: { in: examIds } },
          select: { examId: true, status: true, score: true, startedAt: true, submittedAt: true },
        })
      : [];

    const byExam = new Map<string, typeof attempts>();
    for (const a of attempts) {
      const list = byExam.get(a.examId) ?? [];
      list.push(a);
      byExam.set(a.examId, list);
    }

    const rows: ExamReportRow[] = exams.map((e) => {
      const list = byExam.get(e.id) ?? [];
      const submitted = list.filter((a) => SUBMITTED_STATUSES.includes(a.status));
      const graded = list.filter((a) => a.status === 'GRADED' || a.status === 'FLAGGED');
      const totalMarks = Number(e.totalMarks);
      const avgScorePercent = avg(graded.map((a) => pct(Number(a.score ?? 0), totalMarks)));
      const durations = submitted
        .filter((a) => a.startedAt && a.submittedAt)
        .map((a) => (a.submittedAt!.getTime() - a.startedAt!.getTime()) / 1000);
      const assignedCount = e._count.assignments;
      const denom = assignedCount > 0 ? assignedCount : list.length;
      return {
        examId: e.id,
        title: e.title,
        program: e.program?.name ?? null,
        subject: e.subject?.name ?? null,
        status: e.status,
        totalQuestions: e._count.questions,
        totalMarks,
        assignedCount,
        attemptCount: list.length,
        submittedCount: submitted.length,
        gradedCount: graded.length,
        completionPercent: denom === 0 ? 0 : round1((submitted.length / denom) * 100),
        avgScorePercent,
        avgTimeSeconds: Math.round(avg(durations)),
        opensAt: e.opensAt?.toISOString() ?? null,
        closesAt: e.closesAt?.toISOString() ?? null,
      };
    });

    return { rows, total };
  }

  async getExamHeader(tenantId: string, examId: string): Promise<ExamReportHeader> {
    const e = await this.prisma.exam.findFirstOrThrow({
      where: { tenantId, id: examId },
      select: {
        id: true,
        title: true,
        status: true,
        totalMarks: true,
        program: { select: { name: true } },
        subject: { select: { name: true } },
        _count: { select: { questions: true } },
      },
    });
    return {
      examId: e.id,
      title: e.title,
      program: e.program?.name ?? null,
      subject: e.subject?.name ?? null,
      status: e.status,
      totalMarks: Number(e.totalMarks),
      totalQuestions: e._count.questions,
    };
  }

  async getQuestionMeta(
    tenantId: string,
    questionIds: string[],
  ): Promise<Map<string, QuestionMeta>> {
    const map = new Map<string, QuestionMeta>();
    if (questionIds.length === 0) return map;
    const rows = await this.prisma.question.findMany({
      where: { tenantId, id: { in: questionIds } },
      select: { id: true, type: true, difficulty: true, subject: true, topic: true, payload: true },
    });
    for (const r of rows) {
      map.set(r.id, {
        questionId: r.id,
        stem: stemFromPayload(r.payload),
        type: r.type,
        difficulty: r.difficulty,
        subject: r.subject,
        topic: r.topic,
      });
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // Student reports
  // ---------------------------------------------------------------------------
  async listStudentReports(tenantId: string, f: ReportFilters): Promise<Paged<StudentReportRow>> {
    const where: Prisma.StudentWhereInput = {
      tenantId,
      ...(f.branchId ? { branchId: f.branchId } : {}),
      ...(f.classroomId ? { classrooms: { some: { classroomId: f.classroomId } } } : {}),
      ...(f.q ? { user: { name: { contains: f.q, mode: 'insensitive' } } } : {}),
    };

    const [students, total] = await Promise.all([
      this.prisma.student.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: f.offset,
        take: f.limit,
        select: {
          id: true,
          classLabel: true,
          rollNo: true,
          user: { select: { name: true } },
        },
      }),
      this.prisma.student.count({ where }),
    ]);

    const studentIds = students.map((s) => s.id);
    const [attempts, topicRows] = await Promise.all([
      studentIds.length
        ? this.prisma.examAttempt.findMany({
            where: { tenantId, studentId: { in: studentIds } },
            select: {
              studentId: true,
              status: true,
              score: true,
              exam: { select: { totalMarks: true } },
            },
          })
        : Promise.resolve([]),
      studentIds.length
        ? this.prisma.topicReport.findMany({
            where: { tenantId, studentId: { in: studentIds } },
            select: { studentId: true, attemptsCount: true, correctCount: true, isWeak: true },
          })
        : Promise.resolve([]),
    ]);

    const rows: StudentReportRow[] = students.map((s) => {
      const sa = attempts.filter((a) => a.studentId === s.id);
      const graded = sa.filter((a) => a.status === 'GRADED' || a.status === 'FLAGGED');
      const tr = topicRows.filter((t) => t.studentId === s.id);
      const sumCorrect = tr.reduce((acc, t) => acc + t.correctCount, 0);
      const sumAttempts = tr.reduce((acc, t) => acc + t.attemptsCount, 0);
      return {
        studentId: s.id,
        name: s.user.name,
        classLabel: s.classLabel,
        rollNo: s.rollNo,
        attemptsTotal: sa.length,
        gradedCount: graded.length,
        avgScorePercent: avg(
          graded.map((a) => pct(Number(a.score ?? 0), Number(a.exam.totalMarks))),
        ),
        accuracyPercent: sumAttempts === 0 ? 0 : round1((sumCorrect / sumAttempts) * 100),
        weakTopicCount: tr.filter((t) => t.isWeak).length,
      };
    });

    return { rows, total };
  }

  async getStudentDetail(tenantId: string, studentId: string): Promise<StudentReportDetail> {
    const student = await this.prisma.student.findFirstOrThrow({
      where: { tenantId, id: studentId },
      select: { id: true, classLabel: true, rollNo: true, user: { select: { name: true } } },
    });

    const [attempts, timeAgg, topicRows] = await Promise.all([
      this.prisma.examAttempt.findMany({
        where: { tenantId, studentId, status: { in: GRADED_STATUSES } },
        orderBy: [{ submittedAt: 'asc' }, { createdAt: 'asc' }],
        select: {
          examId: true,
          score: true,
          submittedAt: true,
          gradedAt: true,
          exam: { select: { title: true, totalMarks: true } },
        },
      }),
      this.prisma.attemptAnswer.aggregate({
        where: { tenantId, attempt: { studentId } },
        _sum: { timeSpentSeconds: true },
        _count: { _all: true },
        _avg: { timeSpentSeconds: true },
      }),
      this.prisma.topicReport.findMany({
        where: { tenantId, studentId },
        select: { attemptsCount: true, correctCount: true },
      }),
    ]);

    const sumCorrect = topicRows.reduce((acc, t) => acc + t.correctCount, 0);
    const sumAttempts = topicRows.reduce((acc, t) => acc + t.attemptsCount, 0);

    return {
      student: {
        id: student.id,
        name: student.user.name,
        classLabel: student.classLabel,
        rollNo: student.rollNo,
      },
      trend: attempts.map((a) => ({
        examId: a.examId,
        examTitle: a.exam.title,
        dateIso: (a.submittedAt ?? a.gradedAt)?.toISOString() ?? null,
        scorePercent: pct(Number(a.score ?? 0), Number(a.exam.totalMarks)),
      })),
      totalTimeSeconds: timeAgg._sum.timeSpentSeconds ?? 0,
      avgTimePerQuestionSeconds: round1(Number(timeAgg._avg.timeSpentSeconds ?? 0)),
      accuracyPercent: sumAttempts === 0 ? 0 : round1((sumCorrect / sumAttempts) * 100),
    };
  }

  // ---------------------------------------------------------------------------
  // Topic-wise + weak-topic rollups (TopicReport aggregation)
  // ---------------------------------------------------------------------------
  async listTopicReports(
    tenantId: string,
    f: ReportFilters,
    weakOnly: boolean,
  ): Promise<Paged<TopicRollupRow>> {
    const { subjectNames, topicName } = await this.resolveTaxonomyNames(tenantId, f);

    const where: Prisma.TopicReportWhereInput = {
      tenantId,
      ...(subjectNames ? { subject: { in: subjectNames } } : {}),
      ...(topicName ? { topic: topicName } : {}),
      ...(f.branchId ? { student: { branchId: f.branchId } } : {}),
    };

    const reports = await this.prisma.topicReport.findMany({
      where,
      select: {
        subject: true,
        topic: true,
        attemptsCount: true,
        correctCount: true,
        scorePercent: true,
        isWeak: true,
      },
    });

    type Bucket = {
      subject: string;
      topic: string;
      students: number;
      scoreSum: number;
      correct: number;
      attempts: number;
      weak: number;
    };
    const buckets = new Map<string, Bucket>();
    for (const r of reports) {
      const key = `${r.subject} ${r.topic}`;
      const b = buckets.get(key) ?? {
        subject: r.subject,
        topic: r.topic,
        students: 0,
        scoreSum: 0,
        correct: 0,
        attempts: 0,
        weak: 0,
      };
      b.students += 1;
      b.scoreSum += Number(r.scorePercent);
      b.correct += r.correctCount;
      b.attempts += r.attemptsCount;
      if (r.isWeak) b.weak += 1;
      buckets.set(key, b);
    }

    let all: TopicRollupRow[] = Array.from(buckets.values()).map((b) => ({
      subject: b.subject,
      topic: b.topic,
      studentsAssessed: b.students,
      avgScorePercent: b.students === 0 ? 0 : round1(b.scoreSum / b.students),
      accuracyPercent: b.attempts === 0 ? 0 : round1((b.correct / b.attempts) * 100),
      weakStudents: b.weak,
      weakSharePercent: b.students === 0 ? 0 : round1((b.weak / b.students) * 100),
    }));

    if (weakOnly) {
      all = all.filter((r) => r.weakStudents > 0);
      all.sort(
        (a, b) => b.weakSharePercent - a.weakSharePercent || b.weakStudents - a.weakStudents,
      );
    } else {
      all.sort(
        (a, b) => a.avgScorePercent - b.avgScorePercent || b.studentsAssessed - a.studentsAssessed,
      );
    }

    const total = all.length;
    const rows = all.slice(f.offset, f.offset + f.limit);
    return { rows, total };
  }

  // ---------------------------------------------------------------------------
  // Question-wise analytics (QuestionStat + Question)
  // ---------------------------------------------------------------------------
  async listQuestionReports(
    tenantId: string,
    createdBy: string | undefined,
    f: ReportFilters,
  ): Promise<Paged<QuestionReportRow>> {
    const where: Prisma.QuestionWhereInput = {
      tenantId,
      isActive: true,
      questionStat: { isNot: null },
      ...(createdBy ? { createdBy } : {}),
      ...(f.programId ? { programId: f.programId } : {}),
      ...(f.subjectId ? { subjectId: f.subjectId } : {}),
      ...(f.topicId ? { topicId: f.topicId } : {}),
      ...(f.chapterId ? { chapterId: f.chapterId } : {}),
      ...(f.branchId ? { creator: { branchId: f.branchId } } : {}),
      ...(f.q
        ? {
            OR: [
              { subject: { contains: f.q, mode: 'insensitive' } },
              { topic: { contains: f.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [questions, total] = await Promise.all([
      this.prisma.question.findMany({
        where,
        orderBy: { questionStat: { totalAttempts: 'desc' } },
        skip: f.offset,
        take: f.limit,
        select: {
          id: true,
          type: true,
          difficulty: true,
          subject: true,
          topic: true,
          payload: true,
          questionStat: {
            select: { totalAttempts: true, correctAttempts: true, avgTimeSeconds: true },
          },
        },
      }),
      this.prisma.question.count({ where }),
    ]);

    const rows: QuestionReportRow[] = questions.map((q) => {
      const st = q.questionStat!;
      const totalAttempts = st.totalAttempts;
      const correctPercent =
        totalAttempts === 0 ? 0 : round1((st.correctAttempts / totalAttempts) * 100);
      return {
        questionId: q.id,
        stem: stemFromPayload(q.payload),
        type: q.type,
        difficulty: q.difficulty,
        subject: q.subject,
        topic: q.topic,
        totalAttempts,
        correctAttempts: st.correctAttempts,
        correctPercent,
        avgTimeSeconds: round1(Number(st.avgTimeSeconds)),
        flag: flagFor(totalAttempts, st.correctAttempts),
      };
    });

    return { rows, total };
  }

  // ---------------------------------------------------------------------------
  // Batch / class performance
  // ---------------------------------------------------------------------------
  async listClassReports(tenantId: string, f: ReportFilters): Promise<Paged<ClassReportRow>> {
    const where: Prisma.ClassroomWhereInput = {
      tenantId,
      ...(f.branchId ? { branchId: f.branchId } : {}),
      ...(f.q ? { name: { contains: f.q, mode: 'insensitive' } } : {}),
    };

    const [classes, total] = await Promise.all([
      this.prisma.classroom.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: f.offset,
        take: f.limit,
        select: {
          id: true,
          name: true,
          year: true,
          section: true,
          _count: { select: { students: true } },
        },
      }),
      this.prisma.classroom.count({ where }),
    ]);

    const rows = await Promise.all(
      classes.map(async (c) => {
        const [assignments, enrolled] = await Promise.all([
          this.prisma.examAssignment.findMany({
            where: { tenantId, classroomId: c.id },
            select: { examId: true },
            distinct: ['examId'],
          }),
          this.prisma.classroomStudent.findMany({
            where: { classroomId: c.id },
            select: { studentId: true },
          }),
        ]);
        const examIds = assignments.map((a) => a.examId);
        const studentIds = enrolled.map((s) => s.studentId);

        const attempts =
          examIds.length && studentIds.length
            ? await this.prisma.examAttempt.findMany({
                where: { tenantId, examId: { in: examIds }, studentId: { in: studentIds } },
                select: { status: true, score: true, exam: { select: { totalMarks: true } } },
              })
            : [];

        const submitted = attempts.filter((a) => SUBMITTED_STATUSES.includes(a.status));
        const graded = attempts.filter((a) => a.status === 'GRADED' || a.status === 'FLAGGED');
        const expected = examIds.length * studentIds.length;

        return {
          classroomId: c.id,
          name: c.name,
          year: c.year,
          section: c.section,
          studentCount: c._count.students,
          examsAssigned: examIds.length,
          attemptsTotal: attempts.length,
          submittedCount: submitted.length,
          completionPercent: expected === 0 ? 0 : round1((submitted.length / expected) * 100),
          avgScorePercent: avg(
            graded.map((a) => pct(Number(a.score ?? 0), Number(a.exam.totalMarks))),
          ),
        } satisfies ClassReportRow;
      }),
    );

    return { rows, total };
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------
  private dateRange(field: 'createdAt', f: ReportFilters): Prisma.ExamWhereInput {
    if (!f.dateFrom && !f.dateTo) return {};
    const range: Prisma.DateTimeFilter = {};
    if (f.dateFrom) range.gte = new Date(f.dateFrom);
    if (f.dateTo) {
      const to = new Date(f.dateTo);
      to.setHours(23, 59, 59, 999);
      range.lte = to;
    }
    return field === 'createdAt' ? { createdAt: range } : {};
  }

  /**
   * TopicReport stores subject/topic as denormalized strings, so taxonomy-id
   * filters are resolved to names. A programId (without a subjectId) expands to
   * the names of all its subjects.
   */
  private async resolveTaxonomyNames(
    tenantId: string,
    f: ReportFilters,
  ): Promise<{ subjectNames?: string[]; topicName?: string }> {
    let subjectNames: string[] | undefined;
    let topicName: string | undefined;

    if (f.subjectId) {
      const s = await this.prisma.subject.findFirst({
        where: { tenantId, id: f.subjectId },
        select: { name: true },
      });
      if (s) subjectNames = [s.name];
    } else if (f.programId) {
      const subs = await this.prisma.subject.findMany({
        where: { tenantId, programId: f.programId },
        select: { name: true },
      });
      subjectNames = subs.map((s) => s.name);
    }

    if (f.topicId) {
      const t = await this.prisma.topic.findFirst({
        where: { tenantId, id: f.topicId },
        select: { name: true },
      });
      if (t) topicName = t.name;
    }

    return { subjectNames, topicName };
  }
}

// --- module-local pure helpers -----------------------------------------------
function pct(value: number, outOf: number): number {
  return round1((value / Math.max(1, outOf)) * 100);
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return round1(values.reduce((a, b) => a + b, 0) / values.length);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function flagFor(total: number, correct: number): QuestionFlag {
  if (total === 0) return 'normal';
  const p = correct / total;
  if (p >= 0.95) return 'too_easy';
  if (p <= 0.2) return 'too_hard';
  if (total >= 10 && Math.abs(p - 0.5) < 0.1) return 'ambiguous';
  return 'normal';
}

function stemFromPayload(payload: Prisma.JsonValue | null): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const obj = payload as Record<string, unknown>;
  const raw =
    obj.contentHtml ?? obj.stem ?? obj.text ?? obj.prompt ?? obj.content ?? obj.question ?? '';
  const str = typeof raw === 'string' ? raw : '';
  const clean = str
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
}
