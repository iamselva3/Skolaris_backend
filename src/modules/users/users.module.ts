import { Module } from '@nestjs/common';
import { UsersController } from './controllers/users.controller';
import { PrismaUserRepository } from './repositories/prisma-user.repository';
import { USER_REPOSITORY } from './repositories/user.repository';
import { CreateUserUseCase } from './use-cases/create-user.use-case';
import { DisableUserUseCase } from './use-cases/disable-user.use-case';
import { GetUserUseCase } from './use-cases/get-user.use-case';
import { ListUsersUseCase } from './use-cases/list-users.use-case';
import { UpdateUserUseCase } from './use-cases/update-user.use-case';

@Module({
  controllers: [UsersController],
  providers: [
    CreateUserUseCase,
    ListUsersUseCase,
    GetUserUseCase,
    UpdateUserUseCase,
    DisableUserUseCase,
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
  ],
  exports: [USER_REPOSITORY],
})
export class UsersModule {}
