/**
 * Thin API client for the live OCR pipeline — drives the REAL running backend (no UI, no mocks):
 * login → create upload → PUT bytes to the presigned URL → complete → poll OCR → fetch drafts + authority.
 * Endpoints/shapes match src/modules/{auth,uploads,ocr} controllers (global prefix /api).
 */
import { APIRequestContext } from '@playwright/test';
import { readFileSync } from 'fs';
import type { Draft } from './papers';

export interface Auth {
  token: string;
}

const dataOf = async (res: { ok(): boolean; status(): number; json(): Promise<any>; text(): Promise<string> }, ctx: string) => {
  if (!res.ok()) throw new Error(`${ctx}: HTTP ${res.status()} — ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).data;
};

export const login = async (api: APIRequestContext, email: string, password: string, tenantSlug?: string): Promise<Auth> => {
  const res = await api.post('/api/auth/login', { data: { email, password, ...(tenantSlug ? { tenantSlug } : {}) } });
  const d = await dataOf(res, 'login');
  return { token: d.accessToken };
};

const authHeader = (a: Auth) => ({ Authorization: `Bearer ${a.token}` });

export const createUpload = async (api: APIRequestContext, a: Auth, originalName: string) => {
  const res = await api.post('/api/uploads', {
    headers: authHeader(a),
    data: { originalName, mimeType: 'application/pdf', category: 'ocr-papers' },
  });
  return dataOf(res, 'createUpload'); // { id, signedUrl, httpMethod, requiredHeaders, ... }
};

export const putBytes = async (api: APIRequestContext, signedUrl: string, method: string, headers: Record<string, string> | undefined, pdfPath: string) => {
  const body = readFileSync(pdfPath);
  const res = await api.fetch(signedUrl, {
    method: (method || 'PUT').toUpperCase(),
    headers: { 'content-type': 'application/pdf', ...(headers ?? {}) },
    data: body,
  });
  if (!res.ok()) throw new Error(`putBytes: HTTP ${res.status()} — ${(await res.text()).slice(0, 300)}`);
};

export const completeUpload = async (api: APIRequestContext, a: Auth, uploadId: string) =>
  dataOf(await api.post(`/api/uploads/${uploadId}/complete`, { headers: authHeader(a) }), 'completeUpload');

export const getUpload = async (api: APIRequestContext, a: Auth, uploadId: string) =>
  dataOf(await api.get(`/api/uploads/${uploadId}`, { headers: authHeader(a) }), 'getUpload');

export const getProgress = async (api: APIRequestContext, a: Auth, uploadId: string) =>
  dataOf(await api.get(`/api/ocr/progress/${uploadId}`, { headers: authHeader(a) }), 'getProgress');

export const getDrafts = async (api: APIRequestContext, a: Auth, ocrJobId: string): Promise<Draft[]> => {
  const PAGE_SIZE = 200;
  const all: Draft[] = [];
  let offset = 0;
  for (;;) {
    const res = await api.get(`/api/ocr/jobs/${ocrJobId}/drafts?limit=${PAGE_SIZE}&offset=${offset}`, { headers: authHeader(a) });
    if (!res.ok()) throw new Error(`getDrafts: HTTP ${res.status()} — ${(await res.text()).slice(0, 300)}`);
    const page = (await res.json()).data as Draft[];
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
};

export const getAuthority = async (api: APIRequestContext, a: Auth, ocrJobId: string): Promise<Record<string, any> | null> => {
  const res = await api.get(`/api/ocr/jobs/${ocrJobId}/authority`, { headers: authHeader(a) });
  if (!res.ok()) return null;
  return ((await res.json()).data as Record<string, any>) ?? null;
};

export interface ExtractResult {
  uploadId: string;
  ocrJobId: string;
  drafts: Draft[];
  authority: Record<string, any> | null;
  pages: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Full pipeline for one PDF: upload → OCR → drafts + authority. Polls until READY_FOR_REVIEW / FAILED. */
export const uploadAndExtract = async (
  api: APIRequestContext,
  a: Auth,
  pdfPath: string,
  originalName: string,
  opts: { timeoutMs?: number; pollMs?: number; onProgress?: (p: any) => void } = {},
): Promise<ExtractResult> => {
  const created = await createUpload(api, a, originalName);
  await putBytes(api, created.signedUrl, created.httpMethod, created.requiredHeaders, pdfPath);
  await completeUpload(api, a, created.id);

  const timeout = opts.timeoutMs ?? 20 * 60 * 1000; // scanned 180q papers are slow — generous
  const poll = opts.pollMs ?? 3000;
  const t0 = Date.now();
  let pages = 0;
  for (;;) {
    const p = await getProgress(api, a, created.id);
    pages = p.pageTotal ?? pages;
    opts.onProgress?.(p);
    if (p.uploadStatus === 'READY_FOR_REVIEW' || p.ocrStage === 'COMPLETED') break;
    if (p.uploadStatus === 'FAILED' || p.ocrStage === 'FAILED')
      throw new Error(`OCR FAILED for ${originalName}: ${p.errorMessage ?? 'unknown'}`);
    if (Date.now() - t0 > timeout) throw new Error(`OCR timeout (${timeout}ms) for ${originalName} — stage=${p.ocrStage} ${p.pageProcessed}/${p.pageTotal}`);
    await sleep(poll);
  }

  const upload = await getUpload(api, a, created.id);
  const ocrJobId = upload?.ocrJob?.id;
  if (!ocrJobId) throw new Error(`no ocrJob on upload ${created.id} for ${originalName}`);
  const drafts = await getDrafts(api, a, ocrJobId);
  const authority = await getAuthority(api, a, ocrJobId);
  return { uploadId: created.id, ocrJobId, drafts, authority, pages };
};
