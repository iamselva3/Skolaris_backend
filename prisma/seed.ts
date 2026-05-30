import { Prisma, PrismaClient, Role, QuestionType, Difficulty } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

const env = (key: string, fallback?: string): string => {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing env var: ${key}`);
  }
  return v;
};

async function main(): Promise<void> {
  const tenantName = env('SEED_TENANT_NAME', 'Acme Academy');
  const tenantSlug = env('SEED_TENANT_SLUG', 'acme');

  const superAdminEmail = env('SEED_SUPER_ADMIN_EMAIL', 'admin@acme.test');
  const superAdminPassword = env('SEED_SUPER_ADMIN_PASSWORD', 'Admin123!');

  const teacherEmail = env('SEED_TEACHER_EMAIL', 'teacher@acme.test');
  const teacherPassword = env('SEED_TEACHER_PASSWORD', 'Teacher123!');

  const studentEmail1 = env('SEED_STUDENT_EMAIL_1', 'student1@acme.test');
  const studentEmail2 = env('SEED_STUDENT_EMAIL_2', 'student2@acme.test');
  const studentPassword = env('SEED_STUDENT_PASSWORD', 'Student123!');

  const tenant = await prisma.tenant.upsert({
    where: { slug: tenantSlug },
    update: { name: tenantName },
    create: { name: tenantName, slug: tenantSlug },
  });

  const branch = await prisma.branch.findFirst({
    where: { tenantId: tenant.id, name: 'Main Campus' },
  });
  const mainBranch =
    branch ??
    (await prisma.branch.create({
      data: { tenantId: tenant.id, name: 'Main Campus' },
    }));

  const hashedAdmin = await argon2.hash(superAdminPassword, { type: argon2.argon2id });
  const hashedTeacher = await argon2.hash(teacherPassword, { type: argon2.argon2id });
  const hashedStudent = await argon2.hash(studentPassword, { type: argon2.argon2id });

  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: superAdminEmail } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: superAdminEmail,
      passwordHash: hashedAdmin,
      name: 'Super Admin',
      role: Role.SUPER_ADMIN,
    },
  });

  const teacher = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: teacherEmail } },
    update: {},
    create: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      email: teacherEmail,
      passwordHash: hashedTeacher,
      name: 'Demo Teacher',
      role: Role.TEACHER,
    },
  });

  const studentUser1 = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: studentEmail1 } },
    update: {},
    create: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      email: studentEmail1,
      passwordHash: hashedStudent,
      name: 'Student One',
      role: Role.STUDENT,
    },
  });

  const studentUser2 = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: studentEmail2 } },
    update: {},
    create: {
      tenantId: tenant.id,
      branchId: mainBranch.id,
      email: studentEmail2,
      passwordHash: hashedStudent,
      name: 'Student Two',
      role: Role.STUDENT,
    },
  });

  // --- Phase 2 fixtures ----------------------------------------------------

  // Student profile rows for the two seeded STUDENT users.
  const studentProfile1 = await prisma.student.upsert({
    where: { userId: studentUser1.id },
    update: {},
    create: {
      tenantId: tenant.id,
      userId: studentUser1.id,
      branchId: mainBranch.id,
      classLabel: '10A',
      rollNo: '001',
    },
  });
  const studentProfile2 = await prisma.student.upsert({
    where: { userId: studentUser2.id },
    update: {},
    create: {
      tenantId: tenant.id,
      userId: studentUser2.id,
      branchId: mainBranch.id,
      classLabel: '10A',
      rollNo: '002',
    },
  });

  // Sample classroom.
  let classroom = await prisma.classroom.findFirst({
    where: { tenantId: tenant.id, branchId: mainBranch.id, name: 'Grade 10 — Maths' },
  });
  if (!classroom) {
    classroom = await prisma.classroom.create({
      data: {
        tenantId: tenant.id,
        branchId: mainBranch.id,
        name: 'Grade 10 — Maths',
        year: '2026',
        section: 'A',
        subject: 'Mathematics',
        createdBy: teacher.id,
      },
    });
  }
  await prisma.classroomStudent.upsert({
    where: { classroomId_studentId: { classroomId: classroom.id, studentId: studentProfile1.id } },
    update: {},
    create: { classroomId: classroom.id, studentId: studentProfile1.id },
  });
  await prisma.classroomStudent.upsert({
    where: { classroomId_studentId: { classroomId: classroom.id, studentId: studentProfile2.id } },
    update: {},
    create: { classroomId: classroom.id, studentId: studentProfile2.id },
  });

  // Sample upload + OcrJob + 3 drafts so the frontend has data without the OCR service running.
  const existingUpload = await prisma.upload.findFirst({
    where: { tenantId: tenant.id, originalName: 'sample-paper.pdf' },
  });
  if (!existingUpload) {
    const upload = await prisma.upload.create({
      data: {
        tenantId: tenant.id,
        uploadedBy: teacher.id,
        originalName: 'sample-paper.pdf',
        mimeType: 'application/pdf',
        sizeBytes: BigInt(123_456),
        storageKey: `tenants/${tenant.id}/uploads/seed/sample-paper.pdf`,
        status: 'READY_FOR_REVIEW',
      },
    });
    const job = await prisma.ocrJob.create({
      data: {
        tenantId: tenant.id,
        uploadId: upload.id,
        startedAt: new Date(),
        finishedAt: new Date(),
        overallConfidence: '0.910',
        providerUsed: 'paddle',
        rawOutput: { source: 'seed' },
      },
    });
    await prisma.ocrDraft.createMany({
      data: [
        {
          tenantId: tenant.id,
          ocrJobId: job.id,
          position: 1,
          text: 'What is 7 × 8?',
          detectedType: QuestionType.SINGLE_CHOICE,
          options: [
            { label: '54' },
            { label: '56' },
            { label: '58' },
            { label: '60' },
          ],
          confidence: '0.940',
        },
        {
          tenantId: tenant.id,
          ocrJobId: job.id,
          position: 2,
          text: 'The Earth orbits the Sun.',
          detectedType: QuestionType.TRUE_FALSE,
          options: Prisma.JsonNull,
          confidence: '0.880',
        },
        {
          tenantId: tenant.id,
          ocrJobId: job.id,
          position: 3,
          text: 'The capital of France is ____.',
          detectedType: QuestionType.FILL_BLANK,
          options: Prisma.JsonNull,
          confidence: '0.910',
        },
      ],
    });

    // Notification: "upload ready for review"
    await prisma.notification.create({
      data: {
        tenantId: tenant.id,
        recipientUserId: teacher.id,
        channel: 'IN_APP',
        subject: 'Your upload is ready for review',
        body: '"sample-paper.pdf" extracted 3 draft question(s). Open the review screen to approve.',
        sentAt: new Date(),
      },
    });

    // One manually-created question so the bank is non-empty.
    const q = await prisma.question.create({
      data: {
        tenantId: tenant.id,
        createdBy: teacher.id,
        type: QuestionType.SINGLE_CHOICE,
        payload: { explanation: 'Multiplication of 7 and 8.' },
        subject: 'Mathematics',
        topic: 'Arithmetic',
        difficulty: Difficulty.EASY,
      },
    });
    await prisma.questionOption.createMany({
      data: [
        { tenantId: tenant.id, questionId: q.id, label: '54', isCorrect: false, position: 0 },
        { tenantId: tenant.id, questionId: q.id, label: '56', isCorrect: true, position: 1 },
        { tenantId: tenant.id, questionId: q.id, label: '58', isCorrect: false, position: 2 },
        { tenantId: tenant.id, questionId: q.id, label: '60', isCorrect: false, position: 3 },
      ],
    });
  }

  // --- Phase 3 fixtures ---------------------------------------------------

  const existingExam = await prisma.exam.findFirst({
    where: { tenantId: tenant.id, title: 'Term 1 Quiz — Mathematics' },
  });
  if (!existingExam) {
    await createPhase3ExamFixture({
      tenantId: tenant.id,
      teacherId: teacher.id,
      classroomId: classroom.id,
    });
  }

  // --- Coaching-centre taxonomy: Program → Subject → Topic → Chapter ------

  await seedTaxonomy({ tenantId: tenant.id, teacherId: teacher.id });

  // eslint-disable-next-line no-console
  console.log(
    `Seeded tenant "${tenant.slug}": admin + teacher + 2 students, 1 classroom, 1 upload (READY_FOR_REVIEW + 3 drafts), 1 Q-bank question, 1 published Phase 3 exam (6 questions), 4 programs (Foundation/NEET/IIT-JEE/JEE Advanced) with subjects + starter topics/chapters; teacher assigned to NEET Physics + NEET Chemistry.`,
  );
}

/**
 * Seed the full coaching-centre taxonomy:
 *   - 4 programs (Foundation / NEET / IIT-JEE / JEE Advanced)
 *   - subjects per program (per spec)
 *   - 3–5 starter topics per subject, with 3–5 chapters each
 *   - assign the demo teacher to NEET Physics + NEET Chemistry
 * Idempotent: upserts by unique constraints.
 */
async function seedTaxonomy(input: { tenantId: string; teacherId: string }): Promise<void> {
  const { tenantId, teacherId } = input;

  type ChapterSpec = string;
  type TopicSpec = { name: string; chapters: ChapterSpec[] };
  type SubjectSpec = { name: string; topics: TopicSpec[] };
  type ProgramSpec = { code: string; name: string; subjects: SubjectSpec[] };

  // Generic, syllabus-aligned starter taxonomy. Names are deliberately broad
  // so they apply to any board / coaching-centre style.
  const tree: ProgramSpec[] = [
    {
      code: 'FOUNDATION',
      name: 'Foundation',
      subjects: [
        {
          name: 'Science',
          topics: [
            { name: 'Physical Science', chapters: ['Motion', 'Force', 'Energy'] },
            { name: 'Life Science', chapters: ['Cells', 'Plants', 'Animals'] },
          ],
        },
        {
          name: 'Mathematics',
          topics: [
            { name: 'Arithmetic', chapters: ['Numbers', 'Fractions', 'Percentages'] },
            { name: 'Geometry', chapters: ['Lines & Angles', 'Triangles', 'Circles'] },
          ],
        },
        {
          name: 'Reasoning',
          topics: [
            { name: 'Verbal', chapters: ['Analogies', 'Series', 'Coding–Decoding'] },
            { name: 'Non-Verbal', chapters: ['Pattern Recognition', 'Mirror Images'] },
          ],
        },
        {
          name: 'English',
          topics: [
            { name: 'Grammar', chapters: ['Parts of Speech', 'Tenses', 'Voice'] },
            { name: 'Comprehension', chapters: ['Passage Reading', 'Vocabulary'] },
          ],
        },
      ],
    },
    {
      code: 'NEET',
      name: 'NEET',
      subjects: [
        {
          name: 'Physics',
          topics: [
            { name: 'Mechanics', chapters: ['Kinematics', 'Laws of Motion', 'Work, Energy & Power', 'Rotational Motion'] },
            { name: 'Electrodynamics', chapters: ['Current Electricity', 'Magnetic Effects', 'EM Induction'] },
            { name: 'Modern Physics', chapters: ['Dual Nature', 'Atoms', 'Nuclei'] },
          ],
        },
        {
          name: 'Chemistry',
          topics: [
            { name: 'Physical Chemistry', chapters: ['Mole Concept', 'Thermodynamics', 'Chemical Kinetics'] },
            { name: 'Inorganic Chemistry', chapters: ['Periodic Table', 'Chemical Bonding', 'Coordination Compounds'] },
            { name: 'Organic Chemistry', chapters: ['GOC', 'Hydrocarbons', 'Biomolecules'] },
          ],
        },
        {
          name: 'Botany',
          topics: [
            { name: 'Plant Physiology', chapters: ['Photosynthesis', 'Respiration', 'Mineral Nutrition'] },
            { name: 'Plant Morphology', chapters: ['Root', 'Stem', 'Leaf'] },
            { name: 'Reproduction', chapters: ['Sexual Reproduction in Plants'] },
          ],
        },
        {
          name: 'Zoology',
          topics: [
            { name: 'Human Physiology', chapters: ['Digestion', 'Breathing', 'Body Fluids & Circulation'] },
            { name: 'Animal Diversity', chapters: ['Non-Chordates', 'Chordates'] },
            { name: 'Genetics & Evolution', chapters: ['Principles of Inheritance', 'Molecular Basis'] },
          ],
        },
      ],
    },
    {
      code: 'IIT_JEE',
      name: 'IIT-JEE',
      subjects: [
        {
          name: 'Physics',
          topics: [
            { name: 'Mechanics', chapters: ['Kinematics', 'Newton\'s Laws', 'Work & Energy', 'Rotational Dynamics'] },
            { name: 'Thermodynamics', chapters: ['Heat Transfer', 'Kinetic Theory', 'Laws of Thermodynamics'] },
            { name: 'Optics', chapters: ['Ray Optics', 'Wave Optics'] },
          ],
        },
        {
          name: 'Chemistry',
          topics: [
            { name: 'Physical Chemistry', chapters: ['Atomic Structure', 'Solutions', 'Electrochemistry'] },
            { name: 'Inorganic Chemistry', chapters: ['s-Block', 'p-Block', 'd & f-Block'] },
            { name: 'Organic Chemistry', chapters: ['Isomerism', 'Alcohols & Ethers', 'Aldehydes & Ketones'] },
          ],
        },
        {
          name: 'Mathematics',
          topics: [
            { name: 'Algebra', chapters: ['Quadratic Equations', 'Sequences & Series', 'Permutations & Combinations'] },
            { name: 'Calculus', chapters: ['Limits & Continuity', 'Differentiation', 'Integration'] },
            { name: 'Coordinate Geometry', chapters: ['Straight Lines', 'Circles', 'Conics'] },
          ],
        },
      ],
    },
    {
      code: 'JEE_ADVANCED',
      name: 'JEE Advanced',
      subjects: [
        {
          name: 'Physics',
          topics: [
            { name: 'Mechanics', chapters: ['Rotational Mechanics', 'Gravitation', 'Fluid Mechanics'] },
            { name: 'Electromagnetism', chapters: ['Electrostatics', 'Capacitors', 'Magnetism'] },
            { name: 'Modern Physics', chapters: ['Photoelectric Effect', 'Bohr Model', 'Nuclear Physics'] },
          ],
        },
        {
          name: 'Chemistry',
          topics: [
            { name: 'Physical Chemistry', chapters: ['Ionic Equilibrium', 'Solid State', 'Surface Chemistry'] },
            { name: 'Inorganic Chemistry', chapters: ['Qualitative Analysis', 'Metallurgy'] },
            { name: 'Organic Chemistry', chapters: ['Reaction Mechanisms', 'Amines', 'Polymers'] },
          ],
        },
        {
          name: 'Mathematics',
          topics: [
            { name: 'Algebra', chapters: ['Complex Numbers', 'Matrices & Determinants', 'Probability'] },
            { name: 'Calculus', chapters: ['Application of Derivatives', 'Definite Integration', 'Differential Equations'] },
            { name: 'Vectors & 3D', chapters: ['Vector Algebra', '3D Geometry'] },
          ],
        },
      ],
    },
  ];

  for (const programSpec of tree) {
    const program = await prisma.program.upsert({
      where: { tenantId_code: { tenantId, code: programSpec.code } },
      update: { name: programSpec.name },
      create: { tenantId, code: programSpec.code, name: programSpec.name },
    });

    for (const subjectSpec of programSpec.subjects) {
      const subject = await prisma.subject.upsert({
        where: {
          tenantId_programId_name: {
            tenantId,
            programId: program.id,
            name: subjectSpec.name,
          },
        },
        update: {},
        create: { tenantId, programId: program.id, name: subjectSpec.name },
      });

      let topicPos = 0;
      for (const topicSpec of subjectSpec.topics) {
        const topic = await prisma.topic.upsert({
          where: {
            tenantId_subjectId_name: {
              tenantId,
              subjectId: subject.id,
              name: topicSpec.name,
            },
          },
          update: { position: topicPos },
          create: {
            tenantId,
            subjectId: subject.id,
            name: topicSpec.name,
            position: topicPos,
          },
        });
        topicPos += 1;

        let chapterPos = 0;
        for (const chapterName of topicSpec.chapters) {
          await prisma.chapter.upsert({
            where: {
              tenantId_topicId_name: {
                tenantId,
                topicId: topic.id,
                name: chapterName,
              },
            },
            update: { position: chapterPos },
            create: {
              tenantId,
              topicId: topic.id,
              name: chapterName,
              position: chapterPos,
            },
          });
          chapterPos += 1;
        }
      }
    }
  }

  // Assign the demo teacher to NEET Physics + NEET Chemistry (typical
  // coaching-centre pattern: one teacher covers two related subjects).
  const neetProgram = await prisma.program.findUnique({
    where: { tenantId_code: { tenantId, code: 'NEET' } },
  });
  if (neetProgram) {
    const teacherSubjects = await prisma.subject.findMany({
      where: {
        tenantId,
        programId: neetProgram.id,
        name: { in: ['Physics', 'Chemistry'] },
      },
      select: { id: true },
    });
    for (const s of teacherSubjects) {
      await prisma.teacherSubject.upsert({
        where: { userId_subjectId: { userId: teacherId, subjectId: s.id } },
        update: {},
        create: { userId: teacherId, subjectId: s.id },
      });
    }
  }
}

async function createPhase3ExamFixture(input: {
  tenantId: string;
  teacherId: string;
  classroomId: string;
}): Promise<void> {
  const { tenantId, teacherId, classroomId } = input;
  const now = new Date();
  const opensAt = new Date(now.getTime() - 60 * 60 * 1000); // 1h ago
  const closesAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 1 week

  // Step 1: question bank (6 questions of varied types)
  const subj = 'Mathematics';
  const qsc = await prisma.question.create({
    data: {
      tenantId, createdBy: teacherId, type: QuestionType.SINGLE_CHOICE,
      payload: { contentHtml: '<p>What is 4 × 6?</p>', explanation: '4 × 6 = 24' },
      subject: subj, topic: 'Arithmetic', difficulty: Difficulty.EASY,
      options: {
        create: [
          { tenantId, label: '20', isCorrect: false, position: 0 },
          { tenantId, label: '22', isCorrect: false, position: 1 },
          { tenantId, label: '24', isCorrect: true, position: 2 },
          { tenantId, label: '26', isCorrect: false, position: 3 },
        ],
      },
    },
  });
  const qmc = await prisma.question.create({
    data: {
      tenantId, createdBy: teacherId, type: QuestionType.MULTIPLE_CHOICE,
      payload: { contentHtml: '<p>Select all statements that are true.</p>' },
      subject: subj, topic: 'Numbers', difficulty: Difficulty.MEDIUM,
      options: {
        create: [
          { tenantId, label: '2 is prime', isCorrect: true, position: 0 },
          { tenantId, label: '3 is prime', isCorrect: true, position: 1 },
          { tenantId, label: '4 is prime', isCorrect: false, position: 2 },
          { tenantId, label: '5 is prime', isCorrect: true, position: 3 },
        ],
      },
    },
  });
  const qtf = await prisma.question.create({
    data: {
      tenantId, createdBy: teacherId, type: QuestionType.TRUE_FALSE,
      payload: {
        contentHtml: '<p>The sum of the interior angles of a triangle is 180°.</p>',
        correct: true,
        explanation: 'The sum of angles in any triangle is 180°.',
      },
      subject: subj, topic: 'Geometry', difficulty: Difficulty.EASY,
    },
  });
  const qfb = await prisma.question.create({
    data: {
      tenantId, createdBy: teacherId, type: QuestionType.FILL_BLANK,
      payload: {
        contentHtml: '<p>The theorem a² + b² = c² for right triangles is named after ______.</p>',
        accepted: ['Pythagoras', 'pythagoras'],
        caseSensitive: false,
      },
      subject: subj, topic: 'Geometry', difficulty: Difficulty.MEDIUM,
    },
  });
  const qmf = await prisma.question.create({
    data: {
      tenantId, createdBy: teacherId, type: QuestionType.MATCH_FOLLOWING,
      payload: {
        contentHtml: '<p>Match each shape to its defining property.</p>',
        pairs: [
          { left: 'Square', right: '4 equal sides' },
          { left: 'Triangle', right: '3 sides' },
          { left: 'Pentagon', right: '5 sides' },
        ],
      },
      subject: subj, topic: 'Shapes', difficulty: Difficulty.MEDIUM,
    },
  });
  const qd = await prisma.question.create({
    data: {
      tenantId, createdBy: teacherId, type: QuestionType.DESCRIPTIVE,
      payload: {
        contentHtml: '<p>Explain the Pythagorean theorem and give one real-world application.</p>',
        rubric: 'Explain the Pythagorean theorem in 2–3 sentences.',
        maxWords: 100,
      },
      subject: subj, topic: 'Geometry', difficulty: Difficulty.HARD,
    },
  });

  // Step 2: Exam in DRAFT
  const exam = await prisma.exam.create({
    data: {
      tenantId,
      createdBy: teacherId,
      title: 'Term 1 Quiz — Mathematics',
      description: 'Sample published exam covering arithmetic, geometry, and shapes.',
      durationSeconds: 30 * 60,
      defaultNegativeMarks: 0.25,
      randomizeQuestions: false,
      randomizeOptions: false,
      opensAt,
      closesAt,
      testMode: 'ONLINE',
      antiCheatConfig: {
        requireFullscreen: true,
        blockCopyPaste: true,
        blockRightClick: true,
        tabSwitchThreshold: 3,
        totalViolationThreshold: 10,
        flagAtViolationCount: 5,
      },
    },
  });

  // Step 3: Exam questions
  const items = [
    { questionId: qsc.id, position: 0, marks: 2 },
    { questionId: qmc.id, position: 1, marks: 3 },
    { questionId: qtf.id, position: 2, marks: 1 },
    { questionId: qfb.id, position: 3, marks: 2 },
    { questionId: qmf.id, position: 4, marks: 3 },
    { questionId: qd.id,  position: 5, marks: 4 },
  ];
  await prisma.examQuestion.createMany({
    data: items.map((i) => ({
      tenantId, examId: exam.id, questionId: i.questionId,
      position: i.position, marks: i.marks, negativeMarks: 0.25,
    })),
  });
  await prisma.exam.update({
    where: { id: exam.id },
    data: { totalMarks: items.reduce((acc, i) => acc + i.marks, 0) },
  });

  // Step 4: Assign to classroom
  await prisma.examAssignment.create({
    data: { tenantId, examId: exam.id, classroomId },
  });

  // Step 5: Publish — create one attempt per classroom student.
  const classroomStudents = await prisma.classroomStudent.findMany({
    where: { classroomId },
    select: { studentId: true },
  });
  for (const cs of classroomStudents) {
    await prisma.examAttempt.create({
      data: {
        tenantId,
        examId: exam.id,
        studentId: cs.studentId,
        questionOrderSeed: BigInt(Math.floor(Math.random() * 2 ** 31)),
      },
    });
  }
  await prisma.exam.update({
    where: { id: exam.id },
    data: { status: 'LIVE', publishedAt: now },
  });

  // Step 6: Notification for the teacher (optional)
  await prisma.notification.create({
    data: {
      tenantId,
      recipientUserId: teacherId,
      channel: 'IN_APP',
      subject: `Exam published: ${exam.title}`,
      body: `Assigned to ${classroomStudents.length} student(s). Live until ${closesAt.toISOString()}.`,
      sentAt: now,
    },
  });
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
