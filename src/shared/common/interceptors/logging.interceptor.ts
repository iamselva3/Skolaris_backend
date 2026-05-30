import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { id?: string }>();
    const res = context.switchToHttp().getResponse<Response>();
    const started = Date.now();
    const { method, originalUrl } = req;

    return next.handle().pipe(
      tap({
        next: () => {
          const ms = Date.now() - started;
          this.logger.log(`[${req.id ?? '-'}] ${method} ${originalUrl} ${res.statusCode} ${ms}ms`);
        },
        error: (err: Error) => {
          const ms = Date.now() - started;
          this.logger.warn(
            `[${req.id ?? '-'}] ${method} ${originalUrl} FAILED ${ms}ms — ${err.message}`,
          );
        },
      }),
    );
  }
}
