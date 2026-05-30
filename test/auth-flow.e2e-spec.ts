import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '../src/shared/common/enums/role.enum';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/shared/database/prisma.service';
import request from 'supertest';

/**
 * Full Phase-1 acceptance flow.
 *
 * Requires a running Postgres reachable via DATABASE_URL and `prisma migrate deploy`
 * to have been applied. Run `docker compose up -d db && npm run prisma:migrate` first.
 */
describe('Auth flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tenantSlug = `e2e-${Date.now()}`;
  const adminEmail = `admin-${Date.now()}@e2e.test`;
  const password = 'Password1!';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    prisma = app.get(PrismaService);

    // Seed: a tenant + SUPER_ADMIN to bootstrap; rest exercised via API.
    const argon2 = await import('argon2');
    const tenant = await prisma.tenant.create({
      data: { name: 'E2E Tenant', slug: tenantSlug },
    });
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: adminEmail,
        name: 'E2E Admin',
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        role: Role.SUPER_ADMIN,
      },
    });
  });

  afterAll(async () => {
    // Cascade-deletes branches/users/refresh tokens.
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: 'e2e-' } } });
    await app.close();
  });

  it('login → me → refresh → logout → refresh fails', async () => {
    const server = app.getHttpServer();

    const login = await request(server)
      .post('/api/auth/login')
      .send({ email: adminEmail, password, tenantSlug })
      .expect(200);
    const { accessToken, refreshToken } = login.body.data;
    expect(accessToken).toBeDefined();
    expect(refreshToken).toBeDefined();

    const me = await request(server)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(me.body.data.email).toBe(adminEmail);
    expect(me.body.data.role).toBe(Role.SUPER_ADMIN);

    await request(server).get('/api/auth/me').expect(401);

    const refresh = await request(server)
      .post('/api/auth/refresh')
      .send({ refreshToken })
      .expect(200);
    const newRefresh = refresh.body.data.refreshToken;
    expect(newRefresh).not.toBe(refreshToken);

    // Old refresh token must now be invalid.
    await request(server)
      .post('/api/auth/refresh')
      .send({ refreshToken })
      .expect(401);

    const newAccess = refresh.body.data.accessToken;
    await request(server)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${newAccess}`)
      .send({ refreshToken: newRefresh })
      .expect(204);

    await request(server)
      .post('/api/auth/refresh')
      .send({ refreshToken: newRefresh })
      .expect(401);
  });

  it('forbids TEACHER from POST /tenants and STUDENT from POST /users', async () => {
    const server = app.getHttpServer();

    // Log in as SUPER_ADMIN, create a teacher and a student via API.
    const login = await request(server)
      .post('/api/auth/login')
      .send({ email: adminEmail, password, tenantSlug })
      .expect(200);
    const adminToken = login.body.data.accessToken;

    const teacherEmail = `teacher-${Date.now()}@e2e.test`;
    await request(server)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: teacherEmail,
        name: 'T',
        password,
        role: Role.TEACHER,
      })
      .expect(201);

    const studentEmail = `student-${Date.now()}@e2e.test`;
    await request(server)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: studentEmail,
        name: 'S',
        password,
        role: Role.STUDENT,
      })
      .expect(201);

    const teacherLogin = await request(server)
      .post('/api/auth/login')
      .send({ email: teacherEmail, password, tenantSlug })
      .expect(200);
    const teacherToken = teacherLogin.body.data.accessToken;

    await request(server)
      .post('/api/tenants')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({
        name: 'X',
        slug: 'x',
        admin: { email: 'x@x.test', name: 'X', password },
      })
      .expect(403);

    const studentLogin = await request(server)
      .post('/api/auth/login')
      .send({ email: studentEmail, password, tenantSlug })
      .expect(200);
    const studentToken = studentLogin.body.data.accessToken;

    await request(server)
      .post('/api/users')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({
        email: 'nope@x.test',
        name: 'N',
        password,
        role: Role.STUDENT,
      })
      .expect(403);
  });

  it('enforces tenant isolation: tenant B user cannot read tenant A user', async () => {
    const server = app.getHttpServer();

    // Create tenant B with its own admin via the API (using tenant A's admin).
    const loginA = await request(server)
      .post('/api/auth/login')
      .send({ email: adminEmail, password, tenantSlug })
      .expect(200);
    const tokenA = loginA.body.data.accessToken;
    const meA = await request(server)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    const adminAId: string = meA.body.data.id;

    const slugB = `e2e-${Date.now()}-b`;
    const adminBEmail = `adminb-${Date.now()}@e2e.test`;
    await request(server)
      .post('/api/tenants')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        name: 'Tenant B',
        slug: slugB,
        admin: { email: adminBEmail, name: 'Admin B', password },
      })
      .expect(201);

    const loginB = await request(server)
      .post('/api/auth/login')
      .send({ email: adminBEmail, password, tenantSlug: slugB })
      .expect(200);
    const tokenB = loginB.body.data.accessToken;

    // Tenant B admin should NOT be able to read tenant A's admin user.
    await request(server)
      .get(`/api/users/${adminAId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);
  });

  it('returns 400 on invalid input', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: 'short' })
      .expect(400);
  });
});
