import { Module } from '@nestjs/common';
import { AttemptsModule } from '../attempts/attempts.module';
import { AttemptsRepoModule } from '../attempts/attempts-repo.module';
import { MeViolationsController } from './controllers/me-violations.controller';
import { RecordViolationsUseCase } from './use-cases/record-violations.use-case';
import { ViolationsRepoModule } from './violations-repo.module';

@Module({
  imports: [ViolationsRepoModule, AttemptsRepoModule, AttemptsModule],
  controllers: [MeViolationsController],
  providers: [RecordViolationsUseCase],
})
export class ViolationsModule {}
