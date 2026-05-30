/*
 * End-to-end smoke test for the upload → OCR → review pipeline. Hits the live
 * API: logs in as the seeded teacher, creates an upload, PUTs the bytes to the
 * signed URL, calls /complete, then polls until READY_FOR_REVIEW and asserts
 * that drafts are visible.
 *
 * Acceptance gate: a clean `docker compose up` followed by `npm run verify:uploads`
 * must exit 0.
 *
 * Env (with sane dev defaults):
 *   API_BASE              http://localhost:3000/api
 *   TEACHER_EMAIL         teacher@acme.test
 *   TEACHER_PASSWORD      Teacher123!
 *   POLL_INTERVAL_MS      2000
 *   POLL_TIMEOUT_MS       60000
 */

import { readFile } from 'fs/promises';
import { isAbsolute, join } from 'path';

const API_BASE = process.env.API_BASE ?? 'http://localhost:3000/api';
const TEACHER_EMAIL = process.env.TEACHER_EMAIL ?? 'teacher@acme.test';
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD ?? 'Teacher123!';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 2000);
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 60_000);

// Override the fixture + mime via env so we can smoke-test multiple file types.
const FIXTURE_RELATIVE = process.env.FIXTURE ?? 'fixtures/sample-paper.pdf';
const MIME_TYPE = process.env.MIME ?? 'application/pdf';
const ORIGINAL_NAME = process.env.NAME ?? FIXTURE_RELATIVE.split(/[\\/]/).pop()!;

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
}

interface SignedUploadResponse {
  id: string;
  signedUrl: string;
  storageKey: string;
  expiresAt: string;
  httpMethod: 'PUT' | 'POST';
  requiredHeaders?: Record<string, string>;
}

interface UploadDetailResponse {
  id: string;
  status: string;
  errorMessage: string | null;
  ocrJob: { id: string; draftCounts: Record<string, number> } | null;
}

const fail = (msg: string, extra?: unknown): never => {
  // eslint-disable-next-line no-console
  console.error(`✗ ${msg}`);
  if (extra !== undefined) {
    // eslint-disable-next-line no-console
    console.error(extra);
  }
  process.exit(1);
};

const ok = (msg: string): void => {
  // eslint-disable-next-line no-console
  console.log(`✓ ${msg}`);
};

const apiJson = async <T>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> => {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json');
  }
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(
      `API ${init.method ?? 'GET'} ${path} → ${res.status}: ${
        typeof body === 'string' ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400)
      }`,
    );
  }
  // Standard envelope is `{ data: ... }`; verify scripts only need the data.
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data;
  }
  return body as T;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

(async (): Promise<void> => {
  // eslint-disable-next-line no-console
  console.log(`▸ Verifying upload pipeline against ${API_BASE}`);

  // 1. Login -----------------------------------------------------------------
  const login = await apiJson<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: TEACHER_EMAIL, password: TEACHER_PASSWORD }),
  }).catch((err) => fail(`Login failed for ${TEACHER_EMAIL}`, err));
  if (!login || !login.accessToken) {
    fail('Login response missing accessToken');
    return;
  }
  ok(`logged in as ${TEACHER_EMAIL}`);

  // 2. Read fixture ----------------------------------------------------------
  const fixturePath = isAbsolute(FIXTURE_RELATIVE)
    ? FIXTURE_RELATIVE
    : join(process.cwd(), FIXTURE_RELATIVE);
  const fixture = await readFile(fixturePath).catch((err) =>
    fail(`Failed to read fixture at ${fixturePath}`, err),
  );
  if (!fixture) return; // unreachable, for ts
  ok(`loaded fixture ${FIXTURE_RELATIVE} (${fixture.byteLength} bytes)`);

  // 3. Create upload row + signed URL ---------------------------------------
  const created = await apiJson<SignedUploadResponse>('/uploads', {
    method: 'POST',
    token: login.accessToken,
    body: JSON.stringify({
      originalName: ORIGINAL_NAME,
      mimeType: MIME_TYPE,
      sizeBytes: fixture.byteLength,
    }),
  }).catch((err) => fail('POST /uploads failed', err));
  if (!created) return;
  ok(`created upload ${created.id}`);
  ok(`signedUrl host: ${new URL(created.signedUrl).host}`);

  // 4. Upload bytes to signed URL using the storage adapter's preferred method
  //    (PUT for real GCS/S3, POST for fake-gcs-server).
  const method = created.httpMethod ?? 'PUT';
  const putHeaders = new Headers(created.requiredHeaders ?? {});
  if (!putHeaders.has('content-type')) putHeaders.set('content-type', MIME_TYPE);
  const putRes = await fetch(created.signedUrl, {
    method,
    headers: putHeaders,
    body: fixture,
  });
  if (!putRes.ok) {
    const t = await putRes.text().catch(() => '');
    fail(
      `${method} to signed URL failed: ${putRes.status} ${putRes.statusText} — ${t.slice(0, 400)}`,
    );
  }
  ok(`${method} ${putRes.status} ${putRes.statusText}`);

  // 5. Complete upload -------------------------------------------------------
  await apiJson(`/uploads/${created.id}/complete`, {
    method: 'POST',
    token: login.accessToken,
  }).catch((err) => fail(`POST /uploads/${created.id}/complete failed`, err));
  ok('upload completed; backend transitioned to PROCESSING and enqueued OCR');

  // 6. Poll until READY_FOR_REVIEW or timeout -------------------------------
  const start = Date.now();
  let lastStatus = 'PENDING_UPLOAD';
  let detail: UploadDetailResponse | null = null;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    detail = await apiJson<UploadDetailResponse>(`/uploads/${created.id}`, {
      token: login.accessToken,
    }).catch((err) => fail(`GET /uploads/${created.id} failed`, err));
    if (!detail) return;
    if (detail.status !== lastStatus) {
      ok(`status → ${detail.status}`);
      lastStatus = detail.status;
    }
    if (detail.status === 'READY_FOR_REVIEW') break;
    if (detail.status === 'FAILED') {
      fail(`Upload FAILED: ${detail.errorMessage ?? '(no errorMessage)'}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (!detail || detail.status !== 'READY_FOR_REVIEW') {
    fail(
      `Timed out after ${POLL_TIMEOUT_MS}ms waiting for READY_FOR_REVIEW (last status: ${
        detail?.status ?? '?'
      }). Is the OCR worker running? Try: docker compose up ocr-mock`,
    );
    return;
  }
  const ready: UploadDetailResponse = detail;

  // 7. Drafts visible --------------------------------------------------------
  if (!ready.ocrJob) {
    fail('READY_FOR_REVIEW but no ocrJob attached');
    return;
  }
  const ocrJobId = ready.ocrJob.id;
  const drafts = await apiJson<unknown[]>(`/ocr/jobs/${ocrJobId}/drafts`, {
    token: login.accessToken,
  }).catch((err) => fail(`GET /ocr/jobs/${ocrJobId}/drafts failed`, err));
  if (!drafts || drafts.length === 0) {
    fail(`Expected at least 1 OCR draft, got ${drafts?.length ?? 0}`);
    return;
  }
  ok(`OCR job ${ocrJobId} produced ${drafts.length} draft(s)`);

  // eslint-disable-next-line no-console
  console.log(`\n✓ Pipeline verified end-to-end in ${Date.now() - start}ms`);
  process.exit(0);
})().catch((err) => fail('Unhandled exception', err));
