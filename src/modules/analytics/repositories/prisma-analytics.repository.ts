import { Injectable } from '@nestjs/common';
import {
  QuestionStat as PrismaQuestionStat,
  TopicReport as PrismaTopicReport,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../../shared/database/prisma.service';
import { QuestionStatModel, TopicReportModel } from '../models/analytics.models';
import {
  ExamQuestionStatRow,
  IAnalyticsRepository,
  UpsertQuestionStatInput,
  UpsertTopicReportInput,
} from './analytics.repository';

@Injectable()
export class PrismaAnalyticsRepository implements IAnalyticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async upsertQuestionStat(input: UpsertQuestionStatInput): Promise<QuestionStatModel> {
    const row = await this.prisma.questionStat.upsert({
      where: { questionId: input.questionId },
      update: {
        totalAttempts: input.totalAttempts,
        correctAttempts: input.correctAttempts,
        avgTimeSeconds: input.avgTimeSeconds,
        difficultyScore: input.difficultyScore,
        lastRecomputedAt: new Date(),
      },
      create: {
        questionId: input.questionId,
        tenantId: input.tenantId,
        totalAttempts: input.totalAttempts,
        correctAttempts: input.correctAttempts,
        avgTimeSeconds: input.avgTimeSeconds,
        difficultyScore: input.difficultyScore,
      },
    });
    return this.toQuestionStat(row);
  }

  async upsertTopicReport(input: UpsertTopicReportInput): Promise<TopicReportModel> {
    const row = await this.prisma.topicReport.upsert({
      where: {
        studentId_subject_topic: {
          studentId: input.studentId,
          subject: input.subject,
          topic: input.topic,
        },
      },
      update: {
        attemptsCount: input.attemptsCount,
        correctCount: input.correctCount,
        scorePercent: input.scorePercent,
        isWeak: input.isWeak,
        lastRecomputedAt: new Date(),
      },
      create: {
        tenantId: input.tenantId,
        studentId: input.studentId,
        subject: input.subject,
        topic: input.topic,
        attemptsCount: input.attemptsCount,
        correctCount: input.correctCount,
        scorePercent: input.scorePercent,
        isWeak: input.isWeak,
      },
    });
    return this.toTopicReport(row);
  }

  async getQuestionStat(tenantId: string, questionId: string): Promise<QuestionStatModel | null> {
    const row = await this.prisma.questionStat.findFirst({
      where: { tenantId, questionId },
    });
    return row ? this.toQuestionStat(row) : null;
  }

  async computeQuestionAggregate(
    tenantId: string,
    questionId: string,
  ): Promise<{ total: number; correct: number; avgTime: number }> {
    // Pull all graded answers for this question across all exams.
    const rows = await this.prisma.attemptAnswer.findMany({
      where: {
        tenantId,
        examQuestion: { questionId },
        isCorrect: { not: null },
      },
      select: { isCorrect: true, timeSpentSeconds: true },
    });
    const total = rows.length;
    const correct = rows.filter((r) => r.isCorrect === true).length;
    const avgTime = total === 0 ? 0 : rows.reduce((acc, r) => acc + r.timeSpentSeconds, 0) / total;
    return { total, correct, avgTime };
  }

  async computeStudentTopicAggregates(
    tenantId: string,
    studentId: string,
  ): Promise<Array<{ subject: string; topic: string; total: number; correct: number }>> {
    // Join answers ↔ exam_questions ↔ questions, group by (subject, topic).
    const rows = await this.prisma.attemptAnswer.findMany({
      where: {
        tenantId,
        attempt: { studentId },
        isCorrect: { not: null },
        examQuestion: { question: { subject: { not: null }, topic: { not: null } } },
      },
      select: {
        isCorrect: true,
        examQuestion: { select: { question: { select: { subject: true, topic: true } } } },
      },
    });
    const bucket = new Map<
      string,
      { subject: string; topic: string; total: number; correct: number }
    >();
    for (const r of rows) {
      const subject = r.examQuestion.question.subject;
      const topic = r.examQuestion.question.topic;
      if (!subject || !topic) continue;
      const key = `${subject}${topic}`;
      const b = bucket.get(key) ?? { subject, topic, total: 0, correct: 0 };
      b.total += 1;
      if (r.isCorrect === true) b.correct += 1;
      bucket.set(key, b);
    }
    return Array.from(bucket.values());
  }

  async getExamSummary(tenantId: string, examId: string) {
    const attempts = await this.prisma.examAttempt.findMany({
      where: { tenantId, examId },
      select: { status: true, score: true },
    });
    const submittedCount = attempts.filter(
      (a) => a.status === 'SUBMITTED' || a.status === 'GRADED' || a.status === 'FLAGGED',
    ).length;
    const graded = attempts.filter((a) => a.status === 'GRADED' || a.status === 'FLAGGED');
    const gradedScores = graded.map((a) => Number(a.score ?? 0));
    const avgScore =
      gradedScores.length === 0
        ? 0
        : gradedScores.reduce((acc, s) => acc + s, 0) / gradedScores.length;

    const exam = await this.prisma.exam.findUniqueOrThrow({
      where: { id: examId },
      select: { totalMarks: true },
    });
    const totalMarks = Number(exam.totalMarks) || 1;
    const buckets: Record<string, number> = {
      '0-20': 0,
      '20-40': 0,
      '40-60': 0,
      '60-80': 0,
      '80-100': 0,
    };
    for (const s of gradedScores) {
      const pct = (s / totalMarks) * 100;
      if (pct < 20) buckets['0-20'] += 1;
      else if (pct < 40) buckets['20-40'] += 1;
      else if (pct < 60) buckets['40-60'] += 1;
      else if (pct < 80) buckets['60-80'] += 1;
      else buckets['80-100'] += 1;
    }
    return {
      totalAttempts: attempts.length,
      submittedCount,
      gradedCount: graded.length,
      avgScore,
      distribution: Object.entries(buckets).map(([bucket, count]) => ({ bucket, count })),
    };
  }

  async getExamQuestionStats(tenantId: string, examId: string): Promise<ExamQuestionStatRow[]> {
    const eqRows = await this.prisma.examQuestion.findMany({
      where: { tenantId, examId },
      orderBy: { position: 'asc' },
    });
    const out: ExamQuestionStatRow[] = [];
    for (const eq of eqRows) {
      const answers = await this.prisma.attemptAnswer.findMany({
        where: { tenantId, examQuestionId: eq.id, isCorrect: { not: null } },
        select: { isCorrect: true, timeSpentSeconds: true },
      });
      const totalAnswered = answers.length;
      const correctCount = answers.filter((a) => a.isCorrect === true).length;
      const avgTime =
        totalAnswered === 0
          ? 0
          : answers.reduce((acc, a) => acc + a.timeSpentSeconds, 0) / totalAnswered;
      const pctCorrect = totalAnswered === 0 ? null : correctCount / totalAnswered;
      let flag: ExamQuestionStatRow['flag'] = 'normal';
      if (pctCorrect !== null) {
        if (pctCorrect >= 0.95) flag = 'too_easy';
        else if (pctCorrect <= 0.2) flag = 'too_hard';
        // 'ambiguous': split close to 50/50 with most students attempting it — heuristic.
        else if (totalAnswered >= 10 && Math.abs(pctCorrect - 0.5) < 0.1) flag = 'ambiguous';
      }
      out.push({
        examQuestionId: eq.id,
        questionId: eq.questionId,
        totalAnswered,
        correctCount,
        avgTimeSeconds: avgTime,
        flag,
      });
    }
    return out;
  }

  async getStudentSummary(tenantId: string, studentId: string) {
    const attempts = await this.prisma.examAttempt.findMany({
      where: { tenantId, studentId, status: { in: ['GRADED', 'FLAGGED'] } },
      select: { score: true, exam: { select: { totalMarks: true } } },
    });
    const attemptsTotal = await this.prisma.examAttempt.count({
      where: { tenantId, studentId },
    });
    const percentScores = attempts.map(
      (a) => (Number(a.score ?? 0) / Math.max(1, Number(a.exam.totalMarks))) * 100,
    );
    const avgScore =
      percentScores.length === 0
        ? 0
        : percentScores.reduce((acc, s) => acc + s, 0) / percentScores.length;
    const weakTopicsCount = await this.prisma.topicReport.count({
      where: { tenantId, studentId, isWeak: true },
    });
    return { attemptsTotal, avgScore, weakTopicsCount };
  }

  async getWeakTopics(tenantId: string, studentId: string): Promise<TopicReportModel[]> {
    const rows = await this.prisma.topicReport.findMany({
      where: { tenantId, studentId, isWeak: true },
      orderBy: { scorePercent: 'asc' },
    });
    return rows.map((r) => this.toTopicReport(r));
  }

  // --- mappers ---
  private toQuestionStat(r: PrismaQuestionStat): QuestionStatModel {
    return new QuestionStatModel(
      r.questionId,
      r.tenantId,
      r.totalAttempts,
      r.correctAttempts,
      r.avgTimeSeconds,
      r.difficultyScore,
      r.lastRecomputedAt,
    );
  }

  private toTopicReport(r: PrismaTopicReport): TopicReportModel {
    return new TopicReportModel(
      r.id,
      r.tenantId,
      r.studentId,
      r.subject,
      r.topic,
      r.attemptsCount,
      r.correctCount,
      r.scorePercent,
      r.isWeak,
      r.lastRecomputedAt,
    );
  }

  // Helper to keep Decimal import alive (TS will complain otherwise).
  private _decimalKeeper(): Decimal {
    return new Decimal(0);
  }
}
