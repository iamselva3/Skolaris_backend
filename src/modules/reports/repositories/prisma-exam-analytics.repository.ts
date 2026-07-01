import { Injectable } from '@nestjs/common';
import { AttemptStatus } from '@prisma/client';
import { PrismaService } from '../../../shared/database/prisma.service';
import {
  hasExamLevelMarks,
  resolveEffectiveMarks,
} from '../../exams/scoring/effective-marks';
import {
  ExamAnalyticsHeader,
  ExamDeepAnalytics,
  ExamGroupRow,
  ExamHeatmap,
  ExamQuestionAnalyticsRow,
  ExamStudentBreakdown,
  ExamStudentRow,
  ExamStudentSummary,
  ExamStudentsPage,
  ExamStudentsQuery,
  GroupDifficulty,
  IExamAnalyticsRepository,
  QuestionClassification,
} from './exam-analytics.repository';

const PARTICIPANT_STATUSES: AttemptStatus[] = [
  AttemptStatus.SUBMITTED,
  AttemptStatus.GRADED,
  AttemptStatus.FLAGGED,
];

const r1 = (n: number): number => Math.round(n * 10) / 10;
const pct = (num: number, den: number): number => (den > 0 ? r1((num / den) * 100) : 0);
const mean = (xs: number[]): number => (xs.length ? r1(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

const stemFromPayload = (payload: unknown): string => {
  const html =
    payload && typeof payload === 'object' && typeof (payload as { contentHtml?: unknown }).contentHtml === 'string'
      ? ((payload as { contentHtml: string }).contentHtml)
      : '';
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
};

const imageFromPayload = (payload: unknown): string | null => {
  const html =
    payload && typeof payload === 'object' && typeof (payload as { contentHtml?: unknown }).contentHtml === 'string'
      ? ((payload as { contentHtml: string }).contentHtml)
      : '';
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
};

const classify = (correctPercent: number, participants: number): QuestionClassification => {
  if (participants === 0) return 'normal';
  if (correctPercent < 30) return 'critical';
  if (correctPercent < 50) return 'difficult';
  if (correctPercent < 80) return 'normal';
  return 'easy';
};

const weaknessBand = (accuracy: number): ExamGroupRow['weaknessBand'] => {
  const weakness = 100 - accuracy;
  if (weakness >= 50) return 'High';
  if (weakness >= 25) return 'Medium';
  return 'Low';
};

// Topic/Chapter difficulty indicator by accuracy: >80% Easy, 50–80% Medium, <50% Difficult.
const difficultyBand = (accuracy: number): GroupDifficulty => {
  if (accuracy > 80) return 'Easy';
  if (accuracy >= 50) return 'Medium';
  return 'Difficult';
};

/** Discipline/Batch/Section attribution for a student via an assigned classroom. */
interface Attribution {
  discipline: string | null;
  batch: string | null;
  section: string | null;
}
const NO_ATTRIBUTION: Attribution = { discipline: null, batch: null, section: null };

interface LoadedQuestion {
  examQuestionId: string;
  questionId: string;
  number: number;
  marks: number;
  negativeMarks: number;
  type: string;
  difficulty: string;
  subject: string | null;
  chapter: string | null;
  topic: string | null;
  stem: string;
  imageUrl: string | null;
  payload: any;
}

interface LoadedAttempt {
  id: string;
  studentId: string;
  score: number;
  status: string;
  name: string;
  rollNo: string | null;
  answers: Array<{
    examQuestionId: string;
    isCorrect: boolean | null;
    marksAwarded: number | null;
    timeSpentSeconds: number;
    answerPayload: any;
  }>;
}

interface Loaded {
  header: ExamAnalyticsHeader;
  questions: LoadedQuestion[];
  attempts: LoadedAttempt[];
  assignedStudentIds: Set<string>;
  /** studentId → discipline/batch/section via the classroom this exam was assigned through. */
  attribution: Map<string, Attribution>;
}

/** Per-student aggregate within this exam (drives summary + students table + rank). */
interface StudentAgg {
  studentId: string;
  name: string;
  rollNo: string | null;
  score: number;
  scorePercent: number;
  completionPercent: number;
  status: string;
  correct: number;
  wrong: number;
  unanswered: number;
  accuracy: number;
  negativeMarks: number;
  totalTime: number;
  discipline: string | null;
  batch: string | null;
  section: string | null;
}

@Injectable()
export class PrismaExamAnalyticsRepository implements IExamAnalyticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getHeader(tenantId: string, examId: string): Promise<ExamAnalyticsHeader | null> {
    const exam = await this.prisma.exam.findFirst({
      where: { id: examId, tenantId },
      select: {
        id: true,
        title: true,
        status: true,
        totalMarks: true,
        createdBy: true,
        examMarksPerQuestion: true,
        examNegativeMarks: true,
        program: { select: { name: true } },
        subject: { select: { name: true } },
        _count: { select: { questions: true } },
      },
    });
    if (!exam) return null;
    return {
      examId: exam.id,
      title: exam.title,
      program: exam.program?.name ?? null,
      subject: exam.subject?.name ?? null,
      status: exam.status,
      totalMarks: Number(exam.totalMarks),
      totalQuestions: exam._count.questions,
      examLevelMarks: hasExamLevelMarks({
        examMarksPerQuestion: exam.examMarksPerQuestion,
        examNegativeMarks: exam.examNegativeMarks,
      }),
      createdBy: exam.createdBy,
    };
  }

  private async load(tenantId: string, examId: string): Promise<Loaded | null> {
    const exam = await this.prisma.exam.findFirst({
      where: { id: examId, tenantId },
      select: {
        id: true,
        title: true,
        status: true,
        totalMarks: true,
        createdBy: true,
        examMarksPerQuestion: true,
        examNegativeMarks: true,
        program: { select: { name: true } },
        subject: { select: { name: true } },
      },
    });
    if (!exam) return null;

    const examConfig = {
      examMarksPerQuestion: exam.examMarksPerQuestion,
      examNegativeMarks: exam.examNegativeMarks,
    };

    const [questionRows, attemptRows, assignments] = await Promise.all([
      this.prisma.examQuestion.findMany({
        where: { tenantId, examId },
        orderBy: { position: 'asc' },
        select: {
          id: true,
          questionId: true,
          position: true,
          marks: true,
          negativeMarks: true,
          question: {
            select: { type: true, difficulty: true, subject: true, topic: true, chapter: true, payload: true },
          },
        },
      }),
      this.prisma.examAttempt.findMany({
        where: { tenantId, examId, status: { in: PARTICIPANT_STATUSES } },
        select: {
          id: true,
          studentId: true,
          score: true,
          status: true,
          student: { select: { rollNo: true, user: { select: { name: true } } } },
          answers: {
            select: { examQuestionId: true, isCorrect: true, marksAwarded: true, timeSpentSeconds: true, answerPayload: true },
          },
        },
      }),
      this.prisma.examAssignment.findMany({
        where: { tenantId, examId },
        select: { studentId: true, classroomId: true },
      }),
    ]);

    const questions: LoadedQuestion[] = questionRows.map((q, i) => {
      const eff = resolveEffectiveMarks(examConfig, { marks: q.marks, negativeMarks: q.negativeMarks });
      return {
        examQuestionId: q.id,
        questionId: q.questionId,
        number: q.position + 1 || i + 1,
        marks: eff.marks.toNumber(),
        negativeMarks: eff.negativeMarks.toNumber(),
        type: q.question.type,
        difficulty: q.question.difficulty,
        subject: q.question.subject,
        chapter: q.question.chapter ?? null,
        topic: q.question.topic,
        stem: stemFromPayload(q.question.payload),
        imageUrl: imageFromPayload(q.question.payload),
        payload: q.question.payload,
      };
    });

    const attempts: LoadedAttempt[] = attemptRows.map((a) => ({
      id: a.id,
      studentId: a.studentId,
      score: Number(a.score ?? 0),
      status: a.status,
      name: a.student.user.name,
      rollNo: a.student.rollNo,
      answers: a.answers.map((ans) => ({
        examQuestionId: ans.examQuestionId,
        isCorrect: ans.isCorrect,
        marksAwarded: ans.marksAwarded == null ? null : Number(ans.marksAwarded),
        timeSpentSeconds: ans.timeSpentSeconds,
        answerPayload: ans.answerPayload,
      })),
    }));

    // Expand assignments → distinct assigned students (individual + classroom members)
    // and attribute each student to the classroom THIS exam was assigned through
    // (discipline = subject, batch = name, section). First assigned classroom wins.
    const individualIds = assignments.map((a) => a.studentId).filter((s): s is string => !!s);
    const classroomIds = assignments.map((a) => a.classroomId).filter((c): c is string => !!c);
    const attribution = new Map<string, Attribution>();
    let memberIds: string[] = [];
    if (classroomIds.length) {
      const classrooms = await this.prisma.classroom.findMany({
        where: { id: { in: classroomIds } },
        select: {
          subject: true,
          name: true,
          section: true,
          students: { select: { studentId: true } },
        },
      });
      for (const c of classrooms) {
        for (const m of c.students) {
          memberIds.push(m.studentId);
          if (!attribution.has(m.studentId)) {
            attribution.set(m.studentId, {
              discipline: c.subject,
              batch: c.name,
              section: c.section,
            });
          }
        }
      }
    }
    const assignedStudentIds = new Set<string>([...individualIds, ...memberIds]);

    const attemptedIds = attemptRows.map((a) => a.studentId);
    const unattributedIds = [...new Set([...assignedStudentIds, ...attemptedIds])].filter(
      (id) => !attribution.has(id),
    );

    if (unattributedIds.length > 0) {
      const fallbackClassrooms = await this.prisma.classroomStudent.findMany({
        where: { studentId: { in: unattributedIds } },
        select: {
          studentId: true,
          classroom: {
            select: { subject: true, name: true, section: true },
          },
        },
        orderBy: { joinedAt: 'desc' },
      });
      for (const fc of fallbackClassrooms) {
        if (!attribution.has(fc.studentId)) {
          attribution.set(fc.studentId, {
            discipline: fc.classroom.subject,
            batch: fc.classroom.name,
            section: fc.classroom.section,
          });
        }
      }
    }

    return {
      header: {
        examId: exam.id,
        title: exam.title,
        program: exam.program?.name ?? null,
        subject: exam.subject?.name ?? null,
        status: exam.status,
        totalMarks: Number(exam.totalMarks),
        totalQuestions: questions.length,
        examLevelMarks: hasExamLevelMarks(examConfig),
        createdBy: exam.createdBy,
      },
      questions,
      attempts,
      assignedStudentIds,
      attribution,
    };
  }

  /** Per-question tallies across participants (correct/wrong/time/marks). */
  private tally(loaded: Loaded) {
    const map = new Map<
      string,
      { correct: number; wrong: number; answered: number; timeSum: number; marksSum: number }
    >();
    for (const q of loaded.questions) {
      map.set(q.examQuestionId, { correct: 0, wrong: 0, answered: 0, timeSum: 0, marksSum: 0 });
    }
    for (const at of loaded.attempts) {
      for (const ans of at.answers) {
        const t = map.get(ans.examQuestionId);
        if (!t) continue;
        if (ans.isCorrect === true) {
          t.correct++;
          t.answered++;
          t.timeSum += ans.timeSpentSeconds;
          t.marksSum += ans.marksAwarded ?? 0;
        } else if (ans.isCorrect === false) {
          t.wrong++;
          t.answered++;
          t.timeSum += ans.timeSpentSeconds;
          t.marksSum += ans.marksAwarded ?? 0;
        }
      }
    }
    return map;
  }

  private studentAggs(loaded: Loaded): StudentAgg[] {
    const totalQ = loaded.questions.length;
    const totalMarks = loaded.header.totalMarks;
    const onExam = new Set(loaded.questions.map((q) => q.examQuestionId));
    return loaded.attempts.map((at) => {
      let correct = 0;
      let wrong = 0;
      let negative = 0;
      let time = 0;
      for (const ans of at.answers) {
        if (!onExam.has(ans.examQuestionId)) continue;
        time += ans.timeSpentSeconds;
        if (ans.isCorrect === true) correct++;
        else if (ans.isCorrect === false) wrong++;
        if (ans.marksAwarded != null && ans.marksAwarded < 0) negative += -ans.marksAwarded;
      }
      const answered = correct + wrong;
      const attr = loaded.attribution.get(at.studentId) ?? NO_ATTRIBUTION;
      return {
        studentId: at.studentId,
        name: at.name,
        rollNo: at.rollNo,
        score: at.score,
        scorePercent: pct(at.score, totalMarks),
        completionPercent: pct(answered, totalQ),
        status: at.status,
        correct,
        wrong,
        unanswered: Math.max(0, totalQ - answered),
        accuracy: pct(correct, answered),
        negativeMarks: r1(negative),
        totalTime: time,
        discipline: attr.discipline,
        batch: attr.batch,
        section: attr.section,
      };
    });
  }

  async getDeepAnalytics(tenantId: string, examId: string): Promise<ExamDeepAnalytics | null> {
    const loaded = await this.load(tenantId, examId);
    if (!loaded) return null;

    const participants = loaded.attempts.length;
    const tally = this.tally(loaded);
    const aggs = this.studentAggs(loaded);

    const attendedIds = new Set(loaded.attempts.map((a) => a.studentId));
    const totalStudents = new Set<string>([...loaded.assignedStudentIds, ...attendedIds]).size;
    const scores = aggs.map((a) => a.score);

    const summary: ExamStudentSummary = {
      totalStudents,
      attended: attendedIds.size,
      absent: Math.max(0, totalStudents - attendedIds.size),
      avgScore: mean(scores),
      highestScore: scores.length ? r1(Math.max(...scores)) : 0,
      lowestScore: scores.length ? r1(Math.min(...scores)) : 0,
      avgAccuracyPercent: mean(aggs.map((a) => a.accuracy)),
      avgCompletionSeconds: Math.round(mean(aggs.map((a) => a.totalTime))),
      avgNegativeMarks: mean(aggs.map((a) => a.negativeMarks)),
      totalMarks: loaded.header.totalMarks,
    };

    const questions: ExamQuestionAnalyticsRow[] = loaded.questions.map((q) => {
      const t = tally.get(q.examQuestionId)!;
      const answered = t.correct + t.wrong;
      const unanswered = Math.max(0, participants - answered);
      const correctPercent = pct(t.correct, participants);
      return {
        examQuestionId: q.examQuestionId,
        questionId: q.questionId,
        number: q.number,
        stem: q.stem,
        imageUrl: q.imageUrl,
        type: q.type,
        difficulty: q.difficulty,
        subject: q.subject,
        chapter: q.chapter,
        topic: q.topic,
        attempted: answered,
        correct: t.correct,
        wrong: t.wrong,
        unanswered,
        correctPercent,
        wrongPercent: pct(t.wrong, participants),
        unansweredPercent: pct(unanswered, participants),
        avgTimeSeconds: answered ? r1(t.timeSum / answered) : 0,
        marks: q.marks,
        negativeMarks: q.negativeMarks,
        classification: classify(correctPercent, participants),
      };
    });

    const groupBy = (keyOf: (q: LoadedQuestion) => string | null): ExamGroupRow[] => {
      const groups = new Map<
        string,
        { count: number; correct: number; wrong: number; unanswered: number; answered: number; timeSum: number; marksSum: number; marksMax: number; cells: number }
      >();
      for (const q of loaded.questions) {
        const key = keyOf(q);
        if (!key) continue;
        const t = tally.get(q.examQuestionId)!;
        const answered = t.correct + t.wrong;
        const unanswered = Math.max(0, participants - answered);
        const g =
          groups.get(key) ??
          { count: 0, correct: 0, wrong: 0, unanswered: 0, answered: 0, timeSum: 0, marksSum: 0, marksMax: 0, cells: 0 };
        g.count++;
        g.correct += t.correct;
        g.wrong += t.wrong;
        g.unanswered += unanswered;
        g.answered += answered;
        g.timeSum += t.timeSum;
        g.marksSum += t.marksSum;
        // Max attainable marks for this group = question marks × participants.
        g.marksMax += q.marks * participants;
        g.cells += participants;
        groups.set(key, g);
      }
      return Array.from(groups.entries())
        .map(([name, g]) => {
          const accuracy = pct(g.correct, g.answered);
          return {
            name,
            questionsCount: g.count,
            attempted: g.answered,
            correct: g.correct,
            wrong: g.wrong,
            unanswered: g.unanswered,
            correctPercent: pct(g.correct, g.cells),
            wrongPercent: pct(g.wrong, g.cells),
            unansweredPercent: pct(g.unanswered, g.cells),
            avgAccuracyPercent: accuracy,
            avgScorePercent: pct(Math.max(0, g.marksSum), g.marksMax),
            avgMarks: g.answered ? r1(g.marksSum / g.answered) : 0,
            avgTimeSeconds: g.answered ? r1(g.timeSum / g.answered) : 0,
            difficulty: difficultyBand(accuracy),
            weaknessScore: r1(100 - accuracy),
            weaknessBand: weaknessBand(accuracy),
          };
        })
        .sort((a, b) => b.weaknessScore - a.weaknessScore);
    };

    return {
      header: loaded.header,
      summary,
      questions,
      topics: groupBy((q) => q.topic),
      chapters: groupBy((q) => q.chapter),
      subjects: groupBy((q) => q.subject),
    };
  }

  async getStudents(
    tenantId: string,
    examId: string,
    query: ExamStudentsQuery,
  ): Promise<ExamStudentsPage> {
    const loaded = await this.load(tenantId, examId);
    if (!loaded) return { data: [], total: 0, attended: 0, filters: { disciplines: [], batches: [], sections: [] } };

    const aggs = this.studentAggs(loaded);

    // Rank attendees by score desc (stable), ties keep order.
    const ranked = [...aggs].sort((a, b) => b.score - a.score);
    const rankByStudent = new Map<string, number>();
    ranked.forEach((a, i) => rankByStudent.set(a.studentId, i + 1));

    const rows: ExamStudentRow[] = aggs.map((a) => ({
      studentId: a.studentId,
      name: a.name,
      rollNo: a.rollNo,
      discipline: a.discipline,
      batch: a.batch,
      section: a.section,
      totalScore: a.score,
      scorePercent: a.scorePercent,
      completionPercent: a.completionPercent,
      correct: a.correct,
      wrong: a.wrong,
      unanswered: a.unanswered,
      accuracyPercent: a.accuracy,
      negativeMarks: a.negativeMarks,
      totalTimeSeconds: a.totalTime,
      rank: rankByStudent.get(a.studentId) ?? null,
      status: a.status,
    }));

    // Absent assigned students (no attempt) — shown with zeros + ABSENT status.
    const attendedIds = new Set(aggs.map((a) => a.studentId));
    const absentIds = [...loaded.assignedStudentIds].filter((id) => !attendedIds.has(id));
    if (absentIds.length) {
      const absentStudents = await this.prisma.student.findMany({
        where: { id: { in: absentIds }, tenantId },
        select: { id: true, rollNo: true, user: { select: { name: true } } },
      });
      for (const s of absentStudents) {
        const attr = loaded.attribution.get(s.id) ?? NO_ATTRIBUTION;
        rows.push({
          studentId: s.id,
          name: s.user.name,
          rollNo: s.rollNo,
          discipline: attr.discipline,
          batch: attr.batch,
          section: attr.section,
          totalScore: 0,
          scorePercent: 0,
          completionPercent: 0,
          correct: 0,
          wrong: 0,
          unanswered: loaded.questions.length,
          accuracyPercent: 0,
          negativeMarks: 0,
          totalTimeSeconds: 0,
          rank: null,
          status: 'ABSENT',
        });
      }
    }

    const q = query.q?.trim().toLowerCase();
    let filtered = q
      ? rows.filter((r) => r.name.toLowerCase().includes(q) || (r.rollNo ?? '').toLowerCase().includes(q))
      : rows;

    if (query.status === 'ATTENDED') {
      filtered = filtered.filter((r) => r.status !== 'ABSENT');
    } else if (query.status === 'ABSENT') {
      filtered = filtered.filter((r) => r.status === 'ABSENT');
    }

    const filterOptions = {
      disciplines: [...new Set(filtered.map(r => r.discipline).filter((s): s is string => !!s))].sort(),
      batches: [...new Set(filtered.map(r => r.batch).filter((s): s is string => !!s))].sort(),
      sections: [...new Set(filtered.map(r => r.section).filter((s): s is string => !!s))].sort(),
    };

    if (query.discipline) {
      const disciplines = new Set(query.discipline.split(','));
      filtered = filtered.filter((r) => r.discipline && disciplines.has(r.discipline));
    }
    if (query.batch) {
      const batches = new Set(query.batch.split(','));
      filtered = filtered.filter((r) => r.batch && batches.has(r.batch));
    }
    if (query.section) {
      const sections = new Set(query.section.split(','));
      filtered = filtered.filter((r) => r.section && sections.has(r.section));
    }

    const dir = query.dir === 'asc' ? 1 : -1;
    const sortKey = query.sort ?? 'rank';
    filtered = [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'name':
          return a.name.localeCompare(b.name) * (query.dir === 'desc' ? -1 : 1);
        case 'totalScore':
          return (a.totalScore - b.totalScore) * dir;
        case 'completion':
          return (a.completionPercent - b.completionPercent) * dir;
        case 'accuracy':
          return (a.accuracyPercent - b.accuracyPercent) * dir;
        case 'negativeMarks':
          return (a.negativeMarks - b.negativeMarks) * dir;
        case 'totalTime':
          return (a.totalTimeSeconds - b.totalTimeSeconds) * dir;
        case 'rank':
        default: {
          // Absent (null rank) always sink to the bottom regardless of direction.
          const ra = a.rank ?? Number.MAX_SAFE_INTEGER;
          const rb = b.rank ?? Number.MAX_SAFE_INTEGER;
          if (ra === rb) return 0;
          return query.dir === 'desc' ? rb - ra : ra - rb;
        }
      }
    });

    const total = filtered.length;
    const data = filtered.slice(query.offset, query.offset + query.limit);
    return { data, total, attended: attendedIds.size, filters: filterOptions };
  }

  async getStudentBreakdown(
    tenantId: string,
    examId: string,
    studentId: string,
  ): Promise<ExamStudentBreakdown | null> {
    const loaded = await this.load(tenantId, examId);
    if (!loaded) return null;
    const attempt = loaded.attempts.find((a) => a.studentId === studentId);
    if (!attempt) return null;

    // Rank this student against all attendees (score desc), matching getStudents.
    const aggs = this.studentAggs(loaded);
    const ranked = [...aggs].sort((a, b) => b.score - a.score);
    const rank = ranked.findIndex((a) => a.studentId === studentId);
    const agg = aggs.find((a) => a.studentId === studentId)!;

    const byEq = new Map(attempt.answers.map((ans) => [ans.examQuestionId, ans]));
    const questions = loaded.questions.map((q) => {
      const ans = byEq.get(q.examQuestionId);
      const status: 'correct' | 'wrong' | 'unanswered' =
        ans?.isCorrect === true ? 'correct' : ans?.isCorrect === false ? 'wrong' : 'unanswered';
      return {
        number: q.number,
        stem: q.stem,
        topic: q.topic,
        chapter: q.chapter,
        status,
        marksAwarded: ans?.marksAwarded ?? 0,
        payload: q.payload,
        answerPayload: ans?.answerPayload ?? null,
      };
    });

    return {
      student: { id: attempt.studentId, name: attempt.name, rollNo: attempt.rollNo },
      totalScore: attempt.score,
      summary: {
        rank: rank >= 0 ? rank + 1 : null,
        status: agg.status,
        scorePercent: agg.scorePercent,
        completionPercent: agg.completionPercent,
        accuracyPercent: agg.accuracy,
        totalTimeSeconds: agg.totalTime,
        correct: agg.correct,
        wrong: agg.wrong,
        unanswered: agg.unanswered,
        negativeMarks: agg.negativeMarks,
        discipline: agg.discipline,
        batch: agg.batch,
        section: agg.section,
      },
      questions,
    };
  }

  async getHeatmap(
    tenantId: string,
    examId: string,
    limit: number,
    offset: number,
  ): Promise<ExamHeatmap> {
    const loaded = await this.load(tenantId, examId);
    if (!loaded) return { questions: [], students: [], total: 0 };

    const aggs = this.studentAggs(loaded);
    const ranked = [...aggs].sort((a, b) => b.score - a.score);
    const page = ranked.slice(offset, offset + limit);

    const attemptByStudent = new Map(loaded.attempts.map((a) => [a.studentId, a]));
    const students = page.map((agg) => {
      const attempt = attemptByStudent.get(agg.studentId)!;
      const byEq = new Map(attempt.answers.map((ans) => [ans.examQuestionId, ans]));
      const cells = loaded.questions.map((q) => {
        const ans = byEq.get(q.examQuestionId);
        if (ans?.isCorrect === true) return 1;
        if (ans?.isCorrect === false) return 2;
        return 0;
      });
      return { studentId: agg.studentId, name: agg.name, cells };
    });

    return {
      questions: loaded.questions.map((q) => ({ examQuestionId: q.examQuestionId, number: q.number })),
      students,
      total: ranked.length,
    };
  }
}
