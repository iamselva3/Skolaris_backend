import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import type { AppConfig } from './shared/config/app.config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
    rawBody: true,
  });

  app.setGlobalPrefix('api');

  // CORS: read allowed origins from app config. Dev defaults to localhost:5173 (Vite).
  const cfg = app.get(ConfigService);
  const corsOrigins = cfg.get<AppConfig>('app')?.corsOrigins ?? [];
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-OCR-Signature', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 86400,
  });
  Logger.log(
    `CORS allowed origins: ${corsOrigins.length > 0 ? corsOrigins.join(', ') : '(none — cross-origin disabled)'}`,
    'Bootstrap',
  );

  // Capture the raw request body for routes that need it (HMAC-signed OCR callback).
  // Stored as `req.rawBody` (Buffer). Limit to 5 MiB — OCR callback payloads are JSON metadata only.
  app.use(
    '/api/internal/ocr/callback',
    express.raw({ type: 'application/json', limit: '5mb' }),
    (req: Request & { rawBody?: Buffer; body: unknown }, _res: Response, next: NextFunction) => {
      if (Buffer.isBuffer(req.body)) {
        (req as Request & { rawBody?: Buffer }).rawBody = req.body;
        try {
          req.body = req.body.length > 0 ? JSON.parse(req.body.toString('utf8')) : {};
        } catch {
          req.body = {};
        }
      }
      next();
    },
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.enableShutdownHooks();

  const workerMode = (process.env.WORKER_MODE ?? 'api').toLowerCase();

  // WORKER_MODE=worker → boot the DI container (so the in-process OCR consumer
  // and other processors start) but do NOT bind an HTTP port. Same image,
  // scaled independently from the API.
  if (workerMode === 'worker') {
    await app.init();
    Logger.log(
      'SKOLARIS running as OCR worker (WORKER_MODE=worker) — DI initialised, no HTTP listener.',
      'Bootstrap',
    );
    return;
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`SKOLARIS API listening on http://localhost:${port}/api`, 'Bootstrap');

  if (workerMode === 'both') {
    Logger.log(
      'OCR consumer running IN-PROCESS (WORKER_MODE=both) — no separate worker needed for this deployment.',
      'Bootstrap',
    );
  } else {
    // Operator reminder — in api mode the OCR pipeline needs a separate worker
    // process to consume the BullMQ queue. Forgetting to start one is the #1
    // dev-env footgun. (Set WORKER_MODE=both to consume in-process instead.)
    Logger.log(
      'OCR pipeline requires a worker (WORKER_MODE=api): `npm run ocr:mock` (dev) OR `docker compose up ocr-mock`. ' +
        'Use `npm run dev:full` to start API + worker together, or set WORKER_MODE=both for a single-process deployment. ' +
        'The WorkerAbsenceCron will warn if jobs pile up unconsumed.',
      'Bootstrap',
    );
  }
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to bootstrap', err);
  process.exit(1);
});
