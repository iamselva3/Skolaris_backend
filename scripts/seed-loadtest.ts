/*
 * LOCAL load-test / demo data seeder — SAFE, TAGGED, RE-RUNNABLE.
 *
 * Creates a large but realistic dataset in the SINGLE local tenant so the UI,
 * lists, classrooms and reports can be exercised at scale WITHOUT running 1000
 * live exam attempts:
 *   - N students + M teachers (dummy users, one shared password each)
 *   - a discipline × batch × section classroom matrix (every combo covered)
 *   - students + teachers allocated to classrooms
 *   - a small question bank + a DRAFT question paper ("questions in draft")
 *   - ONE exam, assigned to every classroom
 *   - ATTENDEES students actually attempt it, each EXACTLY 50% correct / 50% wrong,
 *     fully graded (answers + scores match what the app's grader produces)
 *   - QuestionStat + TopicReport rollups populated so report pages aren't empty
 *
 * Everything is tagged (emails @loadtest.local, classroom year LT-2026, titles
 * "Load Test …") and the script DELETES the previous run first, so re-running is
 * idempotent and cleaning up is one command (`--clean`).
 *
 * Run:    npx ts-node scripts/seed-loadtest.ts
 * Clean:  npx ts-node scripts/seed-loadtest.ts --clean
 *
 * LOCAL ONLY — uses DATABASE_URL (localhost). It never touches D1 / any remote DB.
 */
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, Role, QuestionType, Difficulty } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

// ── Tunables (env-overridable) ─────────────────────────────────────────────
const TENANT_SLUG = process.env.LT_TENANT_SLUG ?? 'acme';
const N_STUDENTS = Number(process.env.LT_STUDENTS ?? 1000);
const N_TEACHERS = Number(process.env.LT_TEACHERS ?? 200);
const N_ATTENDEES = Number(process.env.LT_ATTENDEES ?? 100);
const STUDENT_PW = process.env.LT_STUDENT_PW ?? 'Student123!';
const TEACHER_PW = process.env.LT_TEACHER_PW ?? 'Teacher123!';

const EMAIL_DOMAIN = 'loadtest.local';
const CLASSROOM_YEAR = 'LT-2026'; // marker so we never collide with real classrooms
const TAG = 'Load Test'; // title prefix for the exam + paper

const DISCIPLINES = ['NEET', 'IIT-JEE', 'Foundation', 'JEE Advanced'];
const BATCHES = ['Morning Batch', 'Evening Batch', 'Weekend Batch', 'Crash Course', 'Repeater Batch'];
const SECTIONS = ['A', 'B', 'C'];

const Q_COUNT = 20;
const MARKS = 1; // per question (negative 0 → 50% correct == 50% score, clean to verify)
const NEG = 0;

// Subject/topic pairs for the question bank (drives TopicReport rows).
const Q_META = [
  { subject: 'Physics', topic: 'Kinematics' },
  { subject: 'Physics', topic: 'Laws of Motion' },
  { subject: 'Chemistry', topic: 'Mole Concept' },
  { subject: 'Chemistry', topic: 'Periodic Table' },
  { subject: 'Biology', topic: 'Cell Structure' },
  { subject: 'Biology', topic: 'Genetics' },
];
const DIFFS = [Difficulty.EASY, Difficulty.MEDIUM, Difficulty.HARD];

// ── helpers ────────────────────────────────────────────────────────────────
const pad = (n: number, w: number): string => String(n).padStart(w, '0');
const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};
async function createManyChunked<T>(
  label: string,
  rows: T[],
  fn: (batch: T[]) => Promise<unknown>,
  size = 1000,
): Promise<void> {
  for (const batch of chunk(rows, size)) await fn(batch);
  // eslint-disable-next-line no-console
  console.log(`  + ${rows.length} ${label}`);
}

async function cleanup(tenantId: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('Cleaning previous load-test data…');
  // Papers have no user-cascade (createdBy is a scalar) — delete explicitly first.
  await prisma.questionPaper.deleteMany({
    where: { tenantId, title: { startsWith: TAG } },
  });
  // Deleting the dummy users cascades: students → attempts → answers, created
  // classrooms → memberships/assignments, created questions → options/exam-questions,
  // created exams → exam-questions/assignments/attempts. One delete clears the rest.
  const del = await prisma.user.deleteMany({
    where: { tenantId, email: { endsWith: `@${EMAIL_DOMAIN}` } },
  });
  // eslint-disable-next-line no-console
  console.log(`  - removed ${del.count} dummy user(s) and all cascaded rows`);
}

async function main(): Promise<void> {
  const cleanOnly = process.argv.includes('--clean');

  const tenant = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } });
  if (!tenant) throw new Error(`Tenant "${TENANT_SLUG}" not found. Run the base seed first.`);

  const branch =
    (await prisma.branch.findFirst({ where: { tenantId: tenant.id, name: 'Main Campus' } })) ??
    (await prisma.branch.findFirst({ where: { tenantId: tenant.id } })) ??
    (await prisma.branch.create({ data: { tenantId: tenant.id, name: 'Main Campus' } }));

  await cleanup(tenant.id);
  if (cleanOnly) {
    // eslint-disable-next-line no-console
    console.log('Clean complete.');
    return;
  }

  const tenantId = tenant.id;
  const branchId = branch.id;
  // eslint-disable-next-line no-console
  console.log(`Seeding tenant "${tenant.slug}" / branch "${branch.name}" — ${N_STUDENTS} students, ${N_TEACHERS} teachers, ${N_ATTENDEES} attempts…`);

  // Hash each password ONCE and reuse — argon2 is deliberately slow, hashing 1200×
  // would take minutes. All dummy users share one hash (same password).
  const teacherHash = await argon2.hash(TEACHER_PW, { type: argon2.argon2id });
  const studentHash = await argon2.hash(STUDENT_PW, { type: argon2.argon2id });

  // ── Teachers ──────────────────────────────────────────────────────────────
  const teachers = Array.from({ length: N_TEACHERS }, (_, i) => ({
    id: randomUUID(),
    tenantId,
    branchId,
    email: `lt.teacher.${pad(i + 1, 4)}@${EMAIL_DOMAIN}`,
    passwordHash: teacherHash,
    name: `LT Teacher ${pad(i + 1, 4)}`,
    role: Role.TEACHER,
  }));
  await createManyChunked('teachers', teachers, (b) =>
    prisma.user.createMany({ data: b, skipDuplicates: true }),
  );
  const creatorId = teachers[0].id; // owns classrooms / questions / exam

  // ── Students (User + Student profile) ───────────────────────────────────────
  const students = Array.from({ length: N_STUDENTS }, (_, i) => {
    const userId = randomUUID();
    return {
      userId,
      studentId: randomUUID(),
      email: `lt.student.${pad(i + 1, 5)}@${EMAIL_DOMAIN}`,
      name: `LT Student ${pad(i + 1, 5)}`,
      rollNo: pad(i + 1, 5),
    };
  });
  await createManyChunked('student users', students, (b) =>
    prisma.user.createMany({
      data: b.map((s) => ({
        id: s.userId,
        tenantId,
        branchId,
        email: s.email,
        passwordHash: studentHash,
        name: s.name,
        role: Role.STUDENT,
      })),
      skipDuplicates: true,
    }),
  );
  await createManyChunked('student profiles', students, (b) =>
    prisma.student.createMany({
      data: b.map((s) => ({
        id: s.studentId,
        tenantId,
        userId: s.userId,
        branchId,
        rollNo: s.rollNo,
      })),
      skipDuplicates: true,
    }),
  );

  // ── Classroom matrix: discipline × batch × section ─────────────────────────
  const classrooms: Array<{ id: string; subject: string; name: string; section: string }> = [];
  for (const subject of DISCIPLINES) {
    for (const name of BATCHES) {
      for (const section of SECTIONS) {
        classrooms.push({ id: randomUUID(), subject, name, section });
      }
    }
  }
  await createManyChunked('classrooms', classrooms, (b) =>
    prisma.classroom.createMany({
      data: b.map((c) => ({
        id: c.id,
        tenantId,
        branchId,
        name: c.name,
        subject: c.subject,
        section: c.section,
        year: CLASSROOM_YEAR,
        createdBy: creatorId,
      })),
      skipDuplicates: true,
    }),
  );

  // Allocate students (round-robin → every classroom filled, all combos covered).
  const classroomStudents = students.map((s, i) => ({
    classroomId: classrooms[i % classrooms.length].id,
    studentId: s.studentId,
  }));
  await createManyChunked('classroom memberships', classroomStudents, (b) =>
    prisma.classroomStudent.createMany({ data: b, skipDuplicates: true }),
  );

  // Allocate teachers (round-robin → each classroom gets ≥1; teachers spread evenly).
  const classroomTeachers = teachers.map((t, i) => ({
    classroomId: classrooms[i % classrooms.length].id,
    teacherId: t.id,
  }));
  await createManyChunked('teacher allocations', classroomTeachers, (b) =>
    prisma.classroomTeacher.createMany({ data: b, skipDuplicates: true }),
  );

  // ── Question bank (SINGLE_CHOICE, 4 options, 1 correct) ────────────────────
  const questions = Array.from({ length: Q_COUNT }, (_, i) => {
    const meta = Q_META[i % Q_META.length];
    const correctIndex = i % 4;
    const optionIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    return {
      id: randomUUID(),
      subject: meta.subject,
      topic: meta.topic,
      difficulty: DIFFS[i % DIFFS.length],
      correctIndex,
      correctOptionId: optionIds[correctIndex],
      wrongOptionId: optionIds[(correctIndex + 1) % 4],
      optionIds,
      number: i + 1,
    };
  });
  await createManyChunked('questions', questions, (b) =>
    prisma.question.createMany({
      data: b.map((q) => ({
        id: q.id,
        tenantId,
        branchId,
        createdBy: creatorId,
        type: QuestionType.SINGLE_CHOICE,
        payload: { contentHtml: `<p>Load-test question ${q.number} — ${q.subject} / ${q.topic}. Pick the correct option.</p>` },
        subject: q.subject,
        topic: q.topic,
        difficulty: q.difficulty,
      })),
    }),
  );
  const optionRows = questions.flatMap((q) =>
    q.optionIds.map((oid, pos) => ({
      id: oid,
      tenantId,
      questionId: q.id,
      label: `Option ${String.fromCharCode(65 + pos)}`,
      isCorrect: pos === q.correctIndex,
      position: pos,
    })),
  );
  await createManyChunked('question options', optionRows, (b) =>
    prisma.questionOption.createMany({ data: b }),
  );

  // ── DRAFT question paper ("questions in draft") ────────────────────────────
  const paperId = randomUUID();
  await prisma.questionPaper.create({
    data: {
      id: paperId,
      tenantId,
      branchId,
      createdBy: creatorId,
      title: `${TAG} Paper — Mixed Mock`,
      description: 'Auto-generated draft paper for load-test/demo data.',
      durationSeconds: 30 * 60,
      defaultNegativeMarks: NEG,
      totalMarks: Q_COUNT * MARKS,
      status: 'DRAFT',
    },
  });
  await prisma.questionPaperQuestion.createMany({
    data: questions.map((q, i) => ({
      id: randomUUID(),
      paperId,
      questionId: q.id,
      position: i,
      marks: MARKS,
      negativeMarks: NEG,
    })),
  });
  // eslint-disable-next-line no-console
  console.log(`  + 1 DRAFT question paper (${Q_COUNT} questions)`);

  // ── Exam (CLOSED, conducted) ───────────────────────────────────────────────
  const now = new Date();
  const opensAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const closesAt = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
  const examId = randomUUID();
  await prisma.exam.create({
    data: {
      id: examId,
      tenantId,
      branchId,
      createdBy: creatorId,
      title: `${TAG} Exam — Mock Test 1`,
      description: 'Auto-generated conducted exam (50% correct / 50% wrong for every attendee).',
      durationSeconds: 30 * 60,
      totalMarks: Q_COUNT * MARKS,
      defaultNegativeMarks: NEG,
      kind: 'TEST',
      status: 'CLOSED',
      testMode: 'ONLINE',
      opensAt,
      closesAt,
      publishedAt: opensAt,
      sourcePaperId: paperId,
    },
  });
  // ExamQuestion rows (the exam's own copies; answers reference these).
  const examQuestions = questions.map((q, i) => ({
    id: randomUUID(),
    questionId: q.id,
    position: i,
  }));
  await prisma.examQuestion.createMany({
    data: examQuestions.map((eq) => ({
      id: eq.id,
      tenantId,
      examId,
      questionId: eq.questionId,
      position: eq.position,
      marks: MARKS,
      negativeMarks: NEG,
    })),
  });
  // Assign to every classroom.
  await prisma.examAssignment.createMany({
    data: classrooms.map((c) => ({ id: randomUUID(), tenantId, examId, classroomId: c.id })),
  });
  // eslint-disable-next-line no-console
  console.log(`  + 1 CLOSED exam (${Q_COUNT} questions, assigned to ${classrooms.length} classrooms)`);

  // ── Attempts: first ATTENDEES students, each EXACTLY 50% correct ────────────
  const attendees = students.slice(0, Math.min(N_ATTENDEES, students.length));
  const attempts = attendees.map((s, i) => ({
    id: randomUUID(),
    studentId: s.studentId,
    seed: BigInt(1000 + i),
  }));

  // Answers: question is "correct" when (studentIndex + questionIndex) is even →
  // every student gets exactly Q_COUNT/2 correct, and every question is answered
  // correctly by ~50% of students (so per-question stats are meaningful too).
  const answers: Prisma.AttemptAnswerCreateManyInput[] = [];
  const attemptScores: Array<{ id: string; score: number }> = [];
  // per-question tallies for QuestionStat
  const qCorrect = new Map<string, number>(); // questionId -> correct count
  const qTotal = new Map<string, number>();
  // per-(student,subject,topic) tallies for TopicReport
  const topicTally = new Map<string, { studentId: string; subject: string; topic: string; total: number; correct: number }>();

  attempts.forEach((att, si) => {
    let correctCount = 0;
    examQuestions.forEach((eq, qi) => {
      const q = questions[qi];
      const isCorrect = (si + qi) % 2 === 0;
      if (isCorrect) correctCount += 1;
      answers.push({
        id: randomUUID(),
        tenantId,
        attemptId: att.id,
        examQuestionId: eq.id,
        answerPayload: { selectedOptionId: isCorrect ? q.correctOptionId : q.wrongOptionId },
        isCorrect,
        marksAwarded: isCorrect ? MARKS : -NEG,
        timeSpentSeconds: 20 + ((si * 7 + qi * 13) % 40),
      });
      qTotal.set(q.id, (qTotal.get(q.id) ?? 0) + 1);
      if (isCorrect) qCorrect.set(q.id, (qCorrect.get(q.id) ?? 0) + 1);
      const tkey = `${att.studentId}|${q.subject}|${q.topic}`;
      const tb = topicTally.get(tkey) ?? { studentId: att.studentId, subject: q.subject, topic: q.topic, total: 0, correct: 0 };
      tb.total += 1;
      if (isCorrect) tb.correct += 1;
      topicTally.set(tkey, tb);
    });
    const score = correctCount * MARKS - (Q_COUNT - correctCount) * NEG;
    attemptScores.push({ id: att.id, score: Math.max(0, score) });
  });

  await createManyChunked('exam attempts', attempts, (b) =>
    prisma.examAttempt.createMany({
      data: b.map((a, idx) => ({
        id: a.id,
        tenantId,
        examId,
        studentId: a.studentId,
        status: 'GRADED',
        startedAt: opensAt,
        submittedAt: closesAt,
        gradedAt: closesAt,
        score: attemptScores[idx].score,
        autoSubmitted: false,
        questionOrderSeed: a.seed,
      })),
    }),
  );
  await createManyChunked('attempt answers', answers, (b) =>
    prisma.attemptAnswer.createMany({ data: b }),
  );

  // ── Rollups: QuestionStat + TopicReport (so report pages render) ───────────
  const questionStats = questions.map((q) => {
    const total = qTotal.get(q.id) ?? 0;
    const correct = qCorrect.get(q.id) ?? 0;
    return {
      questionId: q.id,
      tenantId,
      totalAttempts: total,
      correctAttempts: correct,
      avgTimeSeconds: new Prisma.Decimal(35),
      difficultyScore: total === 0 ? null : new Prisma.Decimal((1 - correct / total).toFixed(3)),
    };
  });
  await createManyChunked('question stats', questionStats, (b) =>
    prisma.questionStat.createMany({ data: b, skipDuplicates: true }),
  );

  const topicReports = Array.from(topicTally.values()).map((t) => {
    const pct = t.total === 0 ? 0 : (t.correct / t.total) * 100;
    return {
      id: randomUUID(),
      tenantId,
      studentId: t.studentId,
      subject: t.subject,
      topic: t.topic,
      attemptsCount: t.total,
      correctCount: t.correct,
      scorePercent: new Prisma.Decimal(pct.toFixed(2)),
      isWeak: pct < 60,
    };
  });
  await createManyChunked('topic reports', topicReports, (b) =>
    prisma.topicReport.createMany({ data: b, skipDuplicates: true }),
  );

  // ── Summary ────────────────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log('\n──────────────────────────────────────────────');
  // eslint-disable-next-line no-console
  console.log('LOAD-TEST DATA READY');
  // eslint-disable-next-line no-console
  console.log(`  tenant         : ${tenant.slug} (${tenant.name})`);
  // eslint-disable-next-line no-console
  console.log(`  students       : ${N_STUDENTS}  (login: lt.student.00001@${EMAIL_DOMAIN} … pw ${STUDENT_PW})`);
  // eslint-disable-next-line no-console
  console.log(`  teachers       : ${N_TEACHERS} (login: lt.teacher.0001@${EMAIL_DOMAIN} … pw ${TEACHER_PW})`);
  // eslint-disable-next-line no-console
  console.log(`  classrooms     : ${classrooms.length} (${DISCIPLINES.length} disc × ${BATCHES.length} batch × ${SECTIONS.length} sec)`);
  // eslint-disable-next-line no-console
  console.log(`  question bank  : ${Q_COUNT}  +  1 DRAFT paper`);
  // eslint-disable-next-line no-console
  console.log(`  exam attempts  : ${attempts.length} (all GRADED, each exactly 50% correct → score ${Math.round((MARKS * Q_COUNT) / 2)}/${MARKS * Q_COUNT})`);
  // eslint-disable-next-line no-console
  console.log(`  admin login    : use your existing super-admin (e.g. admin@${TENANT_SLUG}.test / Admin123!)`);
  // eslint-disable-next-line no-console
  console.log('  re-run safe    : this script deletes its prior run first. Clean: npx ts-node scripts/seed-loadtest.ts --clean');
  // eslint-disable-next-line no-console
  console.log('──────────────────────────────────────────────');
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
