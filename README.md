# SKOLARIS Backend — Phase 1 + 2 + 3

Foundational backend for the SKOLARIS multi-tenant online exam platform.

**Phase 1** (delivered): tenants, branches, users, JWT auth, RBAC, refresh-token rotation.
**Phase 2** (delivered): students, classrooms, OCR ingestion pipeline (signed-URL uploads → BullMQ → HMAC-authenticated callback → reviewable drafts → approve-into-question-bank), question bank with discriminated-payload validation, notifications outbox, teacher dashboard summary.
**Phase 3** (delivered): exam engine (compose → publish → live → close), student attempt lifecycle (start → answer → heartbeat → submit), grading engine for all 7 question types, anti-cheating violation ingestion with threshold-driven auto-submit, analytics rollups (per-question stats + per-student weak-topic reports) via BullMQ worker, notifications dispatch worker (SMTP via mailhog in dev), cron jobs (auto-submit expired attempts, transition exam status, enqueue dispatch).

Mobile app, descriptive grading queue, partial-credit MCQ, and WebSocket live updates remain out of scope until Phase 4.

## Stack

- Node.js 20+, NestJS 10, TypeScript (strict)
- PostgreSQL 15 + Prisma 5 (`citext` for case-insensitive emails)
- JWT access tokens + rotating refresh tokens (stored as SHA-256 hashes)
- Argon2id password hashing
- `class-validator` + `class-transformer` for DTO validation
- **Phase 2**: BullMQ + Redis 7 (OCR job queue), `@google-cloud/storage` + `@aws-sdk/client-s3` (signed URLs), HMAC-SHA256 for OCR callback authentication
- **Phase 3**: `@nestjs/schedule` (cron), `@nestjs/throttler` (rate limiting violation ingest), `nodemailer` SMTP, two additional BullMQ queues (`analytics.aggregate`, `notifications.dispatch`), `mailhog` SMTP capture for dev
- Jest unit tests + Supertest e2e

## Architecture — five layers per module

```
controllers/   HTTP boundary, DTO validation, no business logic
use-cases/     one class per use case, pure TypeScript
repositories/  interface in domain terms + Prisma implementation
models/        plain domain classes
dtos/          request/response shapes with validation decorators
```

Dependency rule: `controllers → use-cases → repositories → models`. The ORM lives only behind repository implementations — use cases depend on `IUserRepository`, not on Prisma.

## Tenant isolation

Every domain entity except `Tenant` carries `tenant_id`. Every repository method takes `tenantId` as a scoping argument; controllers extract it from `@CurrentUser()` (decoded JWT claim) and pass it down. Cross-tenant reads/writes are impossible by construction. The only exception is SUPER_ADMIN platform-level tenant CRUD, which is explicitly marked.

## Env vars

Copy `.env.example` to `.env` and adjust. Required keys:

| Var | Notes |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Compose exposes db on `localhost:5434`. |
| `JWT_ACCESS_SECRET` | Long random string. |
| `JWT_ACCESS_TTL` | e.g. `15m`. Format: `<n>(ms|s|m|h|d)`. |
| `JWT_REFRESH_SECRET` | Long random string, distinct from access secret. |
| `JWT_REFRESH_TTL` | e.g. `7d`. |
| `SEED_*` | Used only by `prisma db seed`. |
| `REDIS_URL` | Compose exposes redis on `localhost:6380`. |
| `OCR_QUEUE_NAME` | BullMQ queue name, default `ocr.extract`. |
| `OCR_CALLBACK_SECRET` | HMAC secret shared with the OCR microservice. Min 16 chars. |
| `STORAGE_PROVIDER` | `gcs` (default — uses fake-gcs-server in dev) or `s3`. |
| `GCS_BUCKET` / `GCS_API_ENDPOINT` / `GCS_PUBLIC_HOST` | Bucket name; emulator endpoint; URL the **client** uses to reach the bucket (may differ from the API's view, e.g. `localhost:4443` vs `http://fake-gcs:4443`). |
| `AWS_S3_BUCKET` / `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Only needed when `STORAGE_PROVIDER=s3`. |
| `UPLOAD_MAX_BYTES` / `UPLOAD_URL_TTL_SECONDS` | File size limit (default 25 MiB) and signed-URL TTL (default 15 min). |
| `ANALYTICS_QUEUE_NAME` / `NOTIFICATIONS_QUEUE_NAME` | BullMQ queue names. Defaults `analytics.aggregate` / `notifications.dispatch`. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_FROM` | SMTP for the notifications worker. In dev: `localhost:1026` (mailhog), web UI at `http://localhost:8026`. |
| `SMTP_USER` / `SMTP_PASS` | Only needed when pointing at a real provider (SES, SendGrid). Leave blank for mailhog. |

## Setup

```powershell
# 1. install deps
npm install

# 2. start infra: postgres (5434), redis (6380), fake-gcs (4443)
docker compose up -d db redis fake-gcs mailhog

# 3. generate Prisma client + apply migrations
npm run prisma:generate
npm run prisma:migrate:deploy     # applies committed migrations (Phase 1 + Phase 2)

# 4. seed: tenant + super-admin + teacher + 2 students + classroom +
#    upload READY_FOR_REVIEW + 3 OCR drafts + 1 question
npm run prisma:seed

# 5. start API in watch mode
npm run start:dev
# API listens on http://localhost:3000/api
```

To run everything (API + Postgres + Redis + fake storage) in containers:

```powershell
docker compose up --build
```

The api container runs `prisma migrate deploy` on startup. The `ocr-service` definition is a placeholder that only starts when you pass `--profile ocr` — replace it with the real FastAPI image once that service is built.

### Local file uploads against fake-gcs

`fake-gcs-server` accepts unauthenticated PUTs at the host `localhost:4443`. The signed URL the API returns from `POST /uploads` already points there. To test the full lifecycle from a shell:

```powershell
# 1. ask the API for a signed URL
$resp = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/uploads `
  -Headers @{ Authorization = "Bearer <accessToken>" } `
  -Body (@{ originalName='paper.pdf'; mimeType='application/pdf'; sizeBytes=12345 } | ConvertTo-Json) `
  -ContentType 'application/json'

# 2. PUT the file directly to the bucket
Invoke-WebRequest -Method Put -Uri $resp.data.signedUrl `
  -InFile .\paper.pdf -ContentType 'application/pdf'

# 3. tell the API the upload is complete (enqueues OCR job, status → PROCESSING)
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/uploads/$($resp.data.id)/complete" `
  -Headers @{ Authorization = "Bearer <accessToken>" }
```

## Seeded credentials

| Role | Email | Password |
| --- | --- | --- |
| SUPER_ADMIN | admin@acme.test | Admin123! |
| TEACHER | teacher@acme.test | Teacher123! |
| STUDENT | student1@acme.test | Student123! |
| STUDENT | student2@acme.test | Student123! |

All four belong to tenant slug `acme`. Pass `tenantSlug: "acme"` on login to disambiguate if you reuse emails across tenants.

## API

Response envelope: `{ "data": ..., "meta": ... }`. Errors: `{ "statusCode", "error", "message", "requestId" }`.

### Auth — `/api/auth`

| Method | Path | Auth | Roles |
| --- | --- | --- | --- |
| POST | `/login` | — | — |
| POST | `/refresh` | refresh body | — |
| POST | `/logout` | JWT | any |
| GET | `/me` | JWT | any |

### Tenants — `/api/tenants` (platform-level)

| Method | Path | Roles |
| --- | --- | --- |
| POST | `/` | SUPER_ADMIN — creates tenant + initial SUPER_ADMIN user in one transaction |
| GET | `/` | SUPER_ADMIN |
| GET | `/:id` | SUPER_ADMIN |
| PATCH | `/:id` | SUPER_ADMIN |

### Branches — `/api/branches` (tenant-scoped)

| Method | Path | Roles |
| --- | --- | --- |
| POST | `/` | SUPER_ADMIN |
| GET | `/` | SUPER_ADMIN, TEACHER |
| GET | `/:id` | SUPER_ADMIN, TEACHER |
| PATCH | `/:id` | SUPER_ADMIN |
| DELETE | `/:id` | SUPER_ADMIN (soft-delete) |

### Users — `/api/users` (tenant-scoped)

| Method | Path | Roles |
| --- | --- | --- |
| POST | `/` | SUPER_ADMIN, TEACHER (TEACHER may only create STUDENT in own branch) |
| GET | `/` | SUPER_ADMIN, TEACHER |
| GET | `/:id` | any authenticated; STUDENT can only read self |
| PATCH | `/:id` | self (name/password) or SUPER_ADMIN (any field) |
| DELETE | `/:id` | SUPER_ADMIN (disables) |

### Phase 3 endpoints

**Exams** — `/api/exams` (teacher-facing composition)
| Method | Path | Roles |
| --- | --- | --- |
| POST | `/` | SUPER_ADMIN, TEACHER. Creates exam in `DRAFT`. |
| GET | `/` | SUPER_ADMIN, TEACHER. Filters: `status`, `createdBy`, `q`. |
| GET | `/:id` | SUPER_ADMIN, TEACHER. Detail with sections + questions + assignments + anti-cheat config. |
| PATCH | `/:id` | SUPER_ADMIN, TEACHER (own-creator). Editable while `DRAFT`; after publish only `closesAt` may be extended. |
| DELETE | `/:id` | SUPER_ADMIN, TEACHER (own-creator). Only if `DRAFT`. |
| POST | `/:id/sections` `/:id/sections/:sectionId` (PATCH, DELETE) | SUPER_ADMIN, TEACHER |
| POST | `/:id/questions` | SUPER_ADMIN, TEACHER. Body: `{ items: [{ questionId, sectionId?, position, marks, negativeMarks? }] }`. Recomputes `total_marks`. |
| PATCH/DELETE | `/:id/questions/:examQuestionId` | SUPER_ADMIN, TEACHER |
| POST | `/:id/assign` | SUPER_ADMIN, TEACHER. Body: `{ classroomIds?, studentIds? }`. |
| POST | `/:id/publish` | SUPER_ADMIN, TEACHER. Validates completeness, expands assignments → one `ExamAttempt` per student, fires in-app + email notifications. Transitions to `LIVE` if `opensAt` past, else `SCHEDULED`. |
| POST | `/:id/close` | SUPER_ADMIN, TEACHER. Force-close. Auto-submits lingering `IN_PROGRESS` attempts. |
| GET | `/:id/attempts` | SUPER_ADMIN, TEACHER. All attempts with status + score + violation count. |
| GET | `/:id/attempts/:attemptId` | SUPER_ADMIN, TEACHER. Per-attempt detail incl. answers + violation timeline. |
| POST | `/:id/attempts/:attemptId/regrade` | SUPER_ADMIN, TEACHER. Re-runs grading (e.g. after answer-key correction). |

**Student exam** — `/api/me/exams`, `/api/me/attempts`
| Method | Path | Roles |
| --- | --- | --- |
| GET | `/me/exams` | STUDENT. Assigned exams with status + window. |
| GET | `/me/exams/:examId` | STUDENT. Exam metadata + attempt status. 403 if not assigned. |
| POST | `/me/exams/:examId/start` | STUDENT. Idempotent. Validates within `[opensAt, closesAt]`. Returns randomized question list (no answer keys) + `time_remaining_seconds`. |
| GET | `/me/attempts/:attemptId` | STUDENT. Resume — current answers + remaining time. |
| PATCH | `/me/attempts/:attemptId/answers/:examQuestionId` | STUDENT. Idempotent upsert. |
| POST | `/me/attempts/:attemptId/heartbeat` | STUDENT. Body: `{ clientTimeRemainingSeconds }`. Returns server-authoritative remaining; auto-submits + grades inline if elapsed > duration. |
| POST | `/me/attempts/:attemptId/submit` | STUDENT. `IN_PROGRESS → SUBMITTED`. Grading runs inline; `analytics.aggregate` enqueued. |
| GET | `/me/attempts/:attemptId/result` | STUDENT. Score + per-question breakdown. `425 Too Early` if not yet `GRADED`. |

**Anti-cheating ingest** — `/api/me/attempts/:attemptId/violations`
| Method | Path | Roles |
| --- | --- | --- |
| POST | `/violations` | STUDENT. Body: `{ events: [{ type, clientTimestamp, detail? }] }`. Rate-limited at 60/10s. Server evaluates thresholds inline; if hit, auto-submits in same DB transaction and returns `{ autoSubmitted: true }`. |

**Analytics** — `/api/analytics` + `/api/me/reports`
| Method | Path | Roles |
| --- | --- | --- |
| GET | `/analytics/exams/:examId/summary` | SUPER_ADMIN, TEACHER |
| GET | `/analytics/exams/:examId/questions` | SUPER_ADMIN, TEACHER. Flags: `too_easy` / `too_hard` / `ambiguous`. |
| GET | `/analytics/students/:studentId/summary` | SUPER_ADMIN, TEACHER, STUDENT (self) |
| GET | `/analytics/students/:studentId/weak-topics` | same |
| GET | `/me/reports/weak-topics` | STUDENT. Convenience wrapper. |
| GET | `/analytics/questions/:questionId` | SUPER_ADMIN, TEACHER |

### Grading rules (per question type)

| Type | Rule |
| --- | --- |
| SINGLE_CHOICE / TRUE_FALSE | Correct → full marks; wrong → `-negativeMarks`; unanswered → 0. |
| MULTIPLE_CHOICE | All-or-nothing (Phase 3 policy). Strategy class can be swapped later. |
| FILL_BLANK | Trim + case-insensitive (unless `caseSensitive: true`) match against any `accepted[]` entry. |
| MATCH_FOLLOWING | All pairs correct → full; else 0. |
| MATRIX_MATCH | All rows correct → full; else 0. |
| DESCRIPTIVE | `isCorrect = null`, `marksAwarded = 0`. Sets `descriptive_pending: true` on the attempt for the Phase 4 teacher grading queue. |

### Workers + crons

- `analytics.aggregate` worker — recomputes `QuestionStat` for every question touched and `TopicReport` rollups for the student. Fires per attempt grading.
- `notifications.dispatch` worker — drains rows where `channel='EMAIL' AND sent_at IS NULL`. Max 100 per tick, exponential retry (5 attempts), then `failedAt` + `errorMessage`.
- Cron `attempts.auto-submit-expired` — every minute. Submits + grades attempts past `startedAt + duration`.
- Cron `exams.transition-live` — every minute. `SCHEDULED → LIVE` and `LIVE → CLOSED` based on time windows. Force-closes lingering attempts.
- Cron `notifications.dispatch.enqueue` — every 30s. Enqueues a job to fire the dispatch worker (bucketed dedupe via `jobId`).

### Phase 2 endpoints

**Students** — `/api/students`
| Method | Path | Roles |
| --- | --- | --- |
| POST | `/` | SUPER_ADMIN, TEACHER (TEACHER own-branch only). Creates User+Student in one tx. |
| GET | `/` | SUPER_ADMIN, TEACHER. Filters: `branchId`, `classroomId`, `q`. |
| GET | `/:id` | SUPER_ADMIN, TEACHER |
| PATCH | `/:id` | SUPER_ADMIN, TEACHER (own-branch enforced) |
| DELETE | `/:id` | SUPER_ADMIN (disables the underlying user) |

**Classrooms** — `/api/classrooms`
| Method | Path | Roles |
| --- | --- | --- |
| POST | `/` | SUPER_ADMIN, TEACHER (own-branch only). `createdBy` = caller. |
| GET | `/` | SUPER_ADMIN, TEACHER. Filter: `branchId`. Returns `studentCount` per row. |
| GET | `/:id` | SUPER_ADMIN, TEACHER |
| PATCH | `/:id` | SUPER_ADMIN, TEACHER (own-creator only) |
| DELETE | `/:id` | SUPER_ADMIN, TEACHER (own-creator only) |
| POST | `/:id/students` | SUPER_ADMIN, TEACHER. Body: `{ studentIds: string[] }`. Idempotent. |
| DELETE | `/:id/students/:studentId` | SUPER_ADMIN, TEACHER |
| GET | `/:id/students` | SUPER_ADMIN, TEACHER |

**Uploads** — `/api/uploads`
| Method | Path | Roles |
| --- | --- | --- |
| POST | `/` | SUPER_ADMIN, TEACHER. Returns signed PUT URL + `uploadId`. Mime allowlist: PDF, JPEG, PNG, WebP, HEIC. Max 25 MiB. |
| POST | `/:id/complete` | SUPER_ADMIN, TEACHER. Verifies bytes are in storage, creates OcrJob, enqueues BullMQ, status → `PROCESSING`. |
| GET | `/` | SUPER_ADMIN, TEACHER. Filters: `status`, `uploadedBy`. |
| GET | `/:id` | SUPER_ADMIN, TEACHER. Includes OcrJob summary + draft counts. |
| DELETE | `/:id` | SUPER_ADMIN, TEACHER. Only if status ∈ {`PENDING_UPLOAD`, `FAILED`}. Removes object + row. |

**OCR review** — `/api/ocr`
| Method | Path | Roles |
| --- | --- | --- |
| GET | `/jobs/:id` | SUPER_ADMIN, TEACHER. Job status + draft counts by status. |
| GET | `/jobs/:id/drafts` | SUPER_ADMIN, TEACHER. Paginated by `position`. |
| PATCH | `/drafts/:id` | SUPER_ADMIN, TEACHER. Updates `text`/`options`/`detectedType`; marks `EDITED`. |
| POST | `/drafts/:id/approve` | SUPER_ADMIN, TEACHER. Body: `{ type?, options?, correctAnswer?, subject?, topic?, difficulty? }`. Atomically creates Question (+ options with answer key) and links the draft. |
| POST | `/drafts/:id/discard` | SUPER_ADMIN, TEACHER |
| POST | `/drafts/bulk-approve` | SUPER_ADMIN, TEACHER. Body: `{ items: [{ draftId, ... }] }`. Each item in its own transaction so partial failures don't poison the batch. |

**Internal OCR callback** — `/api/internal/ocr/callback`
| Method | Path | Auth |
| --- | --- | --- |
| POST | `/callback` | HMAC-SHA256 header `X-OCR-Signature` over raw body, secret = `OCR_CALLBACK_SECRET`. Idempotent on `ocrJobId`. |

**Questions** — `/api/questions`
| Method | Path | Roles |
| --- | --- | --- |
| POST | `/` | SUPER_ADMIN, TEACHER. Payload validated against the discriminator (`type` → matching payload schema). |
| GET | `/` | SUPER_ADMIN, TEACHER. Filters: `subject`, `topic`, `difficulty`, `type`, `q`. Active questions only. |
| GET | `/:id` | SUPER_ADMIN, TEACHER |
| PATCH | `/:id` | SUPER_ADMIN, TEACHER (own-creator only) |
| DELETE | `/:id` | SUPER_ADMIN, TEACHER (own-creator only). Soft-delete via `is_active=false`. |

**Teacher dashboard** — `/api/dashboard/teacher`
| Method | Path | Roles |
| --- | --- | --- |
| GET | `/summary` | TEACHER, SUPER_ADMIN. Aggregated counts + recent uploads/classrooms in one call. |
| GET | `/notifications` | TEACHER, STUDENT, SUPER_ADMIN. Does NOT mark anything read. |
| POST | `/notifications/:id/read` | TEACHER, STUDENT, SUPER_ADMIN |

### OCR pipeline

1. Client `POST /uploads` → API issues signed PUT URL (15 min) + `Upload` row in `PENDING_UPLOAD`.
2. Client `PUT` file bytes directly to GCS/S3.
3. Client `POST /uploads/:id/complete` → API verifies object exists, creates `OcrJob`, enqueues BullMQ `ocr.extract` job with `{ ocrJobId, tenantId, uploadId, storageKey }`, transitions to `PROCESSING`.
4. OCR microservice (separate FastAPI process) consumes the BullMQ job, downloads file, runs PaddleOCR (+ Google Vision fallback when confidence is low), POSTs results to `/api/internal/ocr/callback` with `X-OCR-Signature`.
5. API verifies HMAC, writes `OcrDraft` rows (idempotent on `ocrJobId`), finalizes `OcrJob`, marks Upload `READY_FOR_REVIEW`, drops a Notification to `uploaded_by`.
6. Teacher reviews drafts, approves with explicit correct-answer payload → `Question` + `QuestionOption` rows persisted atomically. **OCR output never auto-creates questions** — every question requires an explicit approve.

### Question payload shapes

| Type | `payload` | Options? |
| --- | --- | --- |
| `SINGLE_CHOICE` | `{ explanation? }` | ≥2 options, exactly one `isCorrect: true` |
| `MULTIPLE_CHOICE` | `{ explanation? }` | ≥2 options, ≥1 `isCorrect: true` |
| `TRUE_FALSE` | `{ correct: boolean, explanation? }` | none |
| `FILL_BLANK` | `{ accepted: string[], caseSensitive: boolean }` | none |
| `MATCH_FOLLOWING` | `{ pairs: [{ left, right }] }` (≥2) | none |
| `MATRIX_MATCH` | `{ rows: string[], cols: string[], correctMap }` | none |
| `DESCRIPTIVE` | `{ rubric?, maxWords? }` | none |

## Tests

```powershell
npm test                # unit tests (use cases + guard)
npm run test:cov        # with coverage report
npm run test:e2e        # e2e — requires running Postgres + applied migrations
```

The e2e suite spins up the Nest app in-process and hits the real DB. Make sure `docker compose up -d db redis fake-gcs mailhog && npm run prisma:migrate:deploy` ran first. The OCR callback e2e test needs `OCR_CALLBACK_SECRET` (≥16 chars) set in your `.env`.

## Layout

```
src/
├── main.ts
├── app.module.ts
├── modules/
│   ├── auth/             Phase 1
│   ├── tenants/          Phase 1
│   ├── branches/         Phase 1
│   ├── users/            Phase 1
│   ├── students/         Phase 2
│   ├── classrooms/       Phase 2 (incl. membership endpoints)
│   ├── uploads/          Phase 2 (signed-URL issuance + lifecycle)
│   ├── ocr/              Phase 2 (HMAC callback + drafts + approve flow)
│   ├── questions/        Phase 2 (manual CRUD + discriminated-payload validator)
│   ├── notifications/    Phase 2 (skeleton outbox)
│   └── dashboard/        Phase 2 (teacher summary + notifications)
└── shared/
    ├── config/       typed @nestjs/config registerAs() helpers
    ├── database/     PrismaService + global DatabaseModule
    ├── queue/        BullMQ + OcrQueueService
    ├── storage/      ObjectStorage interface + GCS impl + S3 impl
    └── common/       global filter, interceptors, pagination DTOs, Role enum
prisma/
├── schema.prisma
├── seed.ts
├── init/             SQL extensions loaded by Postgres on first boot
└── migrations/
    ├── 20260101000000_init/         Phase 1 tables
    └── 20260601000000_phase2/       Phase 2 tables (students, classrooms, uploads, ocr_*, questions, notifications)
```
