import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/models/authenticated-user.model';
import { Role } from '../../../shared/common/enums/role.enum';
import { ExamModel } from '../models/exam.model';
import { EXAM_REPOSITORY, IExamRepository } from '../repositories/exam.repository';
import {
  IQuestionPaperRepository,
  QUESTION_PAPER_REPOSITORY,
} from '../../question-papers/repositories/question-paper.repository';

/**
 * Snapshots a standalone QuestionPaper into a new Exam (kind='TEST', DRAFT).
 * The exam receives its OWN COPY of the question set (membership + order +
 * marks) as ExamQuestion rows, so later edits to the paper never change this
 * exam (and editing the exam never touches the paper). Question CONTENT stays
 * referenced from the bank. The teacher then configures schedule + assignments
 * and publishes via the normal test lifecycle.
 */
@Injectable()
export class CreateExamFromPaperUseCase {
  constructor(
    @Inject(EXAM_REPOSITORY) private readonly exams: IExamRepository,
    @Inject(QUESTION_PAPER_REPOSITORY) private readonly papers: IQuestionPaperRepository,
  ) {}

  async execute(input: { actor: AuthenticatedUser; paperId: string }): Promise<ExamModel> {
    const detail = await this.papers.findByIdWithQuestions(input.actor.tenantId, input.paperId);
    if (!detail) throw new NotFoundException('Question paper not found');
    if (input.actor.role === Role.TEACHER && detail.paper.createdBy !== input.actor.sub) {
      throw new ForbiddenException('Teachers can only build exams from papers they own');
    }

    const exam = await this.exams.create({
      tenantId: input.actor.tenantId,
      createdBy: input.actor.sub,
      title: detail.paper.title,
      description: detail.paper.description,
      durationSeconds: detail.paper.durationSeconds,
      defaultNegativeMarks: detail.paper.defaultNegativeMarks,
      programId: detail.paper.programId,
      subjectId: detail.paper.subjectId,
      kind: 'TEST',
      sourcePaperId: detail.paper.id,
    });

    if (detail.questions.length > 0) {
      await this.exams.addExamQuestions({
        tenantId: input.actor.tenantId,
        examId: exam.id,
        items: detail.questions.map((q) => ({
          questionId: q.questionId,
          position: q.position,
          marks: q.marks,
          negativeMarks: q.negativeMarks,
        })),
      });
    }

    // Return the freshly-saved exam (with recomputed totalMarks).
    return (await this.exams.findById(input.actor.tenantId, exam.id)) ?? exam;
  }
}
