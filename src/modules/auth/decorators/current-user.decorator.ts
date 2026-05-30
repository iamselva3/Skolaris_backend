import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../models/authenticated-user.model';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    if (!req.user) {
      throw new Error('CurrentUser decorator used on a route without an authenticated user');
    }
    return req.user;
  },
);
