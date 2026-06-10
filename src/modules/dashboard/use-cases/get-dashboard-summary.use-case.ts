import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/database/prisma.service';
import { Role } from '../../../shared/common/enums/role.enum';

/**
 * Shape consumed by the ERP dashboard's module-card grid and the two
 * operational panels (OCR Review Queue + Today's Exams). One batched fetch
 * so the dashboard never fires multiple queries — see project_product_identity.md.
 */
export interface DashboardSummary {
  students: { total: number; newThisWeek: number; weakTopicAlerts: number };
  teachers: { total: number; activeToday: number };
  exams: { liveNow: number; scheduledThisWeek: number };
  questionBank: { totalApproved: number; draftsPending: number };
  uploads: { uploadedToday: number; reviewQueueCount: number };
  createExam: { drafts: number; lastPublishedAt: string | null };
  notifications: { unread: number; totalToday: number };

  ocrReviewQueue: Array<{
    id: string;
    fileName: string;
    program: string | null;
    subject: string | null;
    draftCount: number;
    uploadedAt: string;
  }>;

  todaysExams: Array<{
    id: string;
    program: string | null;
    title: string;
    opensAt: string | null;
    closesAt: string | null;
    status: 'SCHEDULED' | 'LIVE' | 'CLOSED';
    assignedCount: number;
    inProgressCount: number;
  }>;
}

@Injectable()
export class GetDashboardSummaryUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(input: {
    tenantId: string;
    actorUserId: string;
    actorRole: Role;
    /** When set, scope every KPI to this branch. Undefined = tenant-wide ("All branches"). */
    branchId?: string;
  }): Promise<DashboardSummary> {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
    const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const teacherScope = input.actorRole === Role.TEACHER ? input.actorUserId : null;

    // Branch scoping. Entities with a direct branch_id column (Student, User,
    // Exam, Question, Upload) filter on it directly; OcrDraft and TopicReport
    // have no column, so they scope through their owning relation. Each spread
    // is empty when no branch is selected, leaving the query tenant-wide.
    const branchId = input.branchId;
    const branchEq = branchId ? { branchId } : {};
    const draftBranch = branchId ? { ocrJob: { upload: { branchId } } } : {};
    const topicBranch = branchId ? { student: { branchId } } : {};

    // Fan-out — every query runs in parallel.
    const [
      studentsTotal,
      studentsNewThisWeek,
      studentsWeakAlerts,
      teachersTotal,
      teachersActiveToday,
      examsLiveNow,
      examsScheduledThisWeek,
      questionBankTotal,
      draftsPending,
      uploadsToday,
      reviewQueueCount,
      examDrafts,
      lastPublishedExam,
      notificationsUnread,
      notificationsToday,
      ocrReviewQueueRows,
      todaysExamsRows,
    ] = await Promise.all([
      this.prisma.student.count({ where: { tenantId: input.tenantId, ...branchEq } }),
      this.prisma.student.count({
        where: { tenantId: input.tenantId, ...branchEq, createdAt: { gte: startOfWeek } },
      }),
      this.prisma.topicReport.count({
        where: { tenantId: input.tenantId, isWeak: true, ...topicBranch },
      }),
      this.prisma.user.count({
        where: { tenantId: input.tenantId, role: Role.TEACHER, ...branchEq },
      }),
      this.prisma.user.count({
        where: {
          tenantId: input.tenantId,
          role: Role.TEACHER,
          ...branchEq,
          lastLoginAt: { gte: startOfDay },
        },
      }),
      this.prisma.exam.count({
        where: {
          tenantId: input.tenantId,
          ...branchEq,
          status: 'LIVE',
          ...(teacherScope ? { createdBy: teacherScope } : {}),
        },
      }),
      this.prisma.exam.count({
        where: {
          tenantId: input.tenantId,
          ...branchEq,
          status: { in: ['SCHEDULED', 'LIVE'] },
          opensAt: {
            gte: startOfDay,
            lt: new Date(startOfDay.getTime() + 7 * 24 * 60 * 60 * 1000),
          },
          ...(teacherScope ? { createdBy: teacherScope } : {}),
        },
      }),
      this.prisma.question.count({
        where: {
          tenantId: input.tenantId,
          ...branchEq,
          isActive: true,
          ...(teacherScope ? { createdBy: teacherScope } : {}),
        },
      }),
      this.prisma.ocrDraft.count({
        where: {
          tenantId: input.tenantId,
          ...draftBranch,
          status: { in: ['PENDING_REVIEW', 'EDITED'] },
        },
      }),
      this.prisma.upload.count({
        where: {
          tenantId: input.tenantId,
          ...branchEq,
          createdAt: { gte: startOfDay },
          ...(teacherScope ? { uploadedBy: teacherScope } : {}),
        },
      }),
      this.prisma.upload.count({
        where: {
          tenantId: input.tenantId,
          ...branchEq,
          status: 'READY_FOR_REVIEW',
          ...(teacherScope ? { uploadedBy: teacherScope } : {}),
        },
      }),
      this.prisma.exam.count({
        where: {
          tenantId: input.tenantId,
          ...branchEq,
          status: 'DRAFT',
          ...(teacherScope ? { createdBy: teacherScope } : {}),
        },
      }),
      this.prisma.exam.findFirst({
        where: {
          tenantId: input.tenantId,
          ...branchEq,
          publishedAt: { not: null },
          ...(teacherScope ? { createdBy: teacherScope } : {}),
        },
        orderBy: { publishedAt: 'desc' },
        select: { publishedAt: true },
      }),
      this.prisma.notification.count({
        where: {
          tenantId: input.tenantId,
          recipientUserId: input.actorUserId,
          readAt: null,
        },
      }),
      this.prisma.notification.count({
        where: {
          tenantId: input.tenantId,
          recipientUserId: input.actorUserId,
          createdAt: { gte: startOfDay },
        },
      }),
      this.prisma.upload.findMany({
        where: {
          tenantId: input.tenantId,
          ...branchEq,
          status: 'READY_FOR_REVIEW',
          ...(teacherScope ? { uploadedBy: teacherScope } : {}),
        },
        orderBy: { updatedAt: 'desc' },
        take: 6,
        select: {
          id: true,
          originalName: true,
          updatedAt: true,
          program: { select: { name: true } },
          subject: { select: { name: true } },
          ocrJob: {
            select: { _count: { select: { drafts: true } } },
          },
        },
      }),
      this.prisma.exam.findMany({
        where: {
          tenantId: input.tenantId,
          ...branchEq,
          status: { in: ['SCHEDULED', 'LIVE'] },
          OR: [{ opensAt: { lt: endOfDay }, closesAt: { gte: startOfDay } }, { status: 'LIVE' }],
          ...(teacherScope ? { createdBy: teacherScope } : {}),
        },
        orderBy: [{ status: 'asc' }, { opensAt: 'asc' }],
        take: 6,
        select: {
          id: true,
          title: true,
          opensAt: true,
          closesAt: true,
          status: true,
          program: { select: { name: true } },
          _count: { select: { assignments: true } },
          attempts: {
            where: { status: 'IN_PROGRESS' },
            select: { id: true },
          },
        },
      }),
    ]);

    return {
      students: {
        total: studentsTotal,
        newThisWeek: studentsNewThisWeek,
        weakTopicAlerts: studentsWeakAlerts,
      },
      teachers: { total: teachersTotal, activeToday: teachersActiveToday },
      exams: { liveNow: examsLiveNow, scheduledThisWeek: examsScheduledThisWeek },
      questionBank: { totalApproved: questionBankTotal, draftsPending },
      uploads: { uploadedToday: uploadsToday, reviewQueueCount },
      createExam: {
        drafts: examDrafts,
        lastPublishedAt: lastPublishedExam?.publishedAt?.toISOString() ?? null,
      },
      notifications: { unread: notificationsUnread, totalToday: notificationsToday },

      ocrReviewQueue: ocrReviewQueueRows.map((u) => ({
        id: u.id,
        fileName: u.originalName,
        program: u.program?.name ?? null,
        subject: u.subject?.name ?? null,
        draftCount: u.ocrJob?._count.drafts ?? 0,
        uploadedAt: u.updatedAt.toISOString(),
      })),

      todaysExams: todaysExamsRows.map((e) => ({
        id: e.id,
        program: e.program?.name ?? null,
        title: e.title,
        opensAt: e.opensAt?.toISOString() ?? null,
        closesAt: e.closesAt?.toISOString() ?? null,
        status: e.status as 'SCHEDULED' | 'LIVE' | 'CLOSED',
        assignedCount: e._count.assignments,
        inProgressCount: e.attempts.length,
      })),
    };
  }
}
