import { defineConfig } from '@playwright/test';

/**
 * Live OCR regression validation — API-driven (no browser needed; the suite drives the real backend
 * HTTP API). Run with: npm run regression:e2e  (after setting the env in e2e/README.md).
 *
 * Serial + single worker: OCR is CPU-heavy and the sidecar is a single shared service, so running
 * papers in parallel would contend and skew timings. Retries are OFF — the suite ITSELF checks
 * determinism by uploading each paper multiple times; a flaky result must surface, not be retried away.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30 * 60 * 1000,
  reporter: [['list'], ['html', { outputFolder: 'e2e/report/html', open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    ignoreHTTPSErrors: true,
  },
});
