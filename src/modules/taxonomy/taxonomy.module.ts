import { Module } from '@nestjs/common';
import { ChaptersController } from './controllers/chapters.controller';
import { ProgramsController } from './controllers/programs.controller';
import { MySubjectsController, SubjectsController } from './controllers/subjects.controller';
import { TopicsController } from './controllers/topics.controller';
import { PrismaTaxonomyRepository } from './repositories/prisma-taxonomy.repository';
import { TAXONOMY_REPOSITORY } from './repositories/taxonomy.repository';
import { TaxonomyResolverService } from './services/taxonomy-resolver.service';
import {
  CreateChapterUseCase,
  DeleteChapterUseCase,
  GetChapterUseCase,
  ListChaptersUseCase,
  UpdateChapterUseCase,
} from './use-cases/chapters.use-cases';
import {
  CreateProgramUseCase,
  GetProgramUseCase,
  ListProgramsUseCase,
  UpdateProgramUseCase,
} from './use-cases/programs.use-cases';
import {
  CreateSubjectUseCase,
  GetSubjectUseCase,
  ListMySubjectsUseCase,
  ListSubjectsUseCase,
  UpdateSubjectUseCase,
} from './use-cases/subjects.use-cases';
import {
  CreateTopicUseCase,
  DeleteTopicUseCase,
  GetTopicUseCase,
  ListTopicsUseCase,
  UpdateTopicUseCase,
} from './use-cases/topics.use-cases';

@Module({
  controllers: [
    ProgramsController,
    SubjectsController,
    MySubjectsController,
    TopicsController,
    ChaptersController,
  ],
  providers: [
    { provide: TAXONOMY_REPOSITORY, useClass: PrismaTaxonomyRepository },
    TaxonomyResolverService,
    // programs
    ListProgramsUseCase,
    GetProgramUseCase,
    CreateProgramUseCase,
    UpdateProgramUseCase,
    // subjects
    ListSubjectsUseCase,
    GetSubjectUseCase,
    CreateSubjectUseCase,
    UpdateSubjectUseCase,
    ListMySubjectsUseCase,
    // topics
    ListTopicsUseCase,
    GetTopicUseCase,
    CreateTopicUseCase,
    UpdateTopicUseCase,
    DeleteTopicUseCase,
    // chapters
    ListChaptersUseCase,
    GetChapterUseCase,
    CreateChapterUseCase,
    UpdateChapterUseCase,
    DeleteChapterUseCase,
  ],
  exports: [TAXONOMY_REPOSITORY, TaxonomyResolverService],
})
export class TaxonomyModule {}
