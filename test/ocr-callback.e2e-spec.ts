import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createHmac } from 'crypto';
import * as express from 'express';
import request from 'supertest';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from '../src/app.module';
import { Role } from '../src/shared/common/enums/role.enum';
import { PrismaService } from '../src/shared/database/prisma.service';

/**
 * End-to-end test for the internal OCR callback.
 *
 * Requires Postgres + Redis running. The test only exercises
 * the HMAC-protected callback path — no real file upload, no real OCR service.
 */
describe('OCR callback flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const slug = `ocr-e2e-${Date.now()}`;
  let tenantId: string;
  let teacherId: string;
  let uploadId: string;
  let ocrJobId: string;
  const secret = process.env.OCR_CALLBACK_SECRET ?? '';

  beforeAll(async () => {
    if (!secret || secret.length < 16) {
      throw new Error('Set OCR_CALLBACK_SECRET (≥16 chars) before running this test');
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api');

    // Same rawBody capture as main.ts so the HMAC guard can verify.
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
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);

    // Seed: a tenant + teacher + upload + ocr_job ready to receive the callback.
    const argon2 = await import('argon2');
    const tenant = await prisma.tenant.create({ data: { name: 'OCR E2E', slug } });
    tenantId = tenant.id;
    const teacher = await prisma.user.create({
      data: {
        tenantId,
        email: `teacher-${Date.now()}@ocre2e.test`,
        name: 'OCR Teacher',
        passwordHash: await argon2.hash('Teacher123!', { type: argon2.argon2id }),
        role: Role.TEACHER,
      },
    });
    teacherId = teacher.id;
    const upload = await prisma.upload.create({
      data: {
        tenantId,
        uploadedBy: teacherId,
        originalName: 'e2e.pdf',
        mimeType: 'application/pdf',
        storageKey: `tenants/${tenantId}/uploads/e2e.pdf`,
        status: 'PROCESSING',
      },
    });
    uploadId = upload.id;
    const job = await prisma.ocrJob.create({
      data: { tenantId, uploadId },
    });
    ocrJobId = job.id;
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: 'ocr-e2e-' } } });
    await app.close();
  });

  const sign = (payload: object): { raw: string; signature: string } => {
    const raw = JSON.stringify(payload);
    const signature = createHmac('sha256', secret).update(raw).digest('hex');
    return { raw, signature };
  };

  it('rejects callback with missing signature (401)', async () => {
    await request(app.getHttpServer())
      .post('/api/internal/ocr/callback')
      .set('Content-Type', 'application/json')
      .send({ ocrJobId, drafts: [] })
      .expect(401);
  });

  it('rejects callback with wrong signature (401)', async () => {
    const payload = { ocrJobId, drafts: [{ position: 0, text: 'Q' }] };
    const { raw } = sign(payload);
    await request(app.getHttpServer())
      .post('/api/internal/ocr/callback')
      .set('Content-Type', 'application/json')
      .set('X-OCR-Signature', '0'.repeat(64))
      .send(raw)
      .expect(401);
  });

  it('accepts valid signature, writes drafts, marks upload READY_FOR_REVIEW, notifies', async () => {
    const payload = {
      ocrJobId,
      overallConfidence: 0.92,
      providerUsed: 'paddle',
      drafts: [
        { position: 0, text: 'What is 2+2?' },
        { position: 1, text: 'The sky is blue.' },
        { position: 2, text: 'Capital of France is ____.' },
      ],
    };
    const { raw, signature } = sign(payload);
    const res = await request(app.getHttpServer())
      .post('/api/internal/ocr/callback')
      .set('Content-Type', 'application/json')
      .set('X-OCR-Signature', signature)
      .send(raw)
      .expect(200);

    expect(res.body.data.draftsWritten).toBe(3);

    const draftCount = await prisma.ocrDraft.count({ where: { ocrJobId } });
    expect(draftCount).toBe(3);

    const upload = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } });
    expect(upload.status).toBe('READY_FOR_REVIEW');

    const notif = await prisma.notification.findFirst({
      where: { tenantId, recipientUserId: teacherId },
      orderBy: { createdAt: 'desc' },
    });
    expect(notif).not.toBeNull();
    expect(notif?.subject).toMatch(/ready for review/i);
  });

  it('is idempotent on replay', async () => {
    const payload = {
      ocrJobId,
      overallConfidence: 0.92,
      providerUsed: 'paddle',
      drafts: [
        { position: 0, text: 'duplicate' },
        { position: 1, text: 'duplicate' },
      ],
    };
    const { raw, signature } = sign(payload);
    const res = await request(app.getHttpServer())
      .post('/api/internal/ocr/callback')
      .set('Content-Type', 'application/json')
      .set('X-OCR-Signature', signature)
      .send(raw)
      .expect(200);

    expect(res.body.data.alreadyProcessed).toBe(true);
    expect(res.body.data.draftsWritten).toBe(0);

    const draftCount = await prisma.ocrDraft.count({ where: { ocrJobId } });
    expect(draftCount).toBe(3); // unchanged from previous test
  });
});
