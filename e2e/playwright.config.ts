import { defineConfig } from '@playwright/test';

/**
 * The browser half of the acceptance suite.
 *
 * One project, one worker, no retries. A journey test that passes on the
 * second attempt has told you nothing you can act on, and the stack it runs
 * against is stateful — a retry would replay registrations against a portal
 * that already has them.
 *
 * Artifacts land next to the container logs `run.sh` collects, so a CI failure
 * comes with a trace and a screenshot of the step that failed.
 */
export default defineConfig({
  testDir: './src',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { outputFolder: artifact('playwright-report'), open: 'never' }]],
  outputDir: artifact('playwright-results'),
  use: {
    baseURL: process.env.E2E_PORTAL_URL ?? 'http://127.0.0.1:8787',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
});

/** Artifacts go where `run.sh` collects from, so one upload has everything. */
function artifact(name: string): string {
  const base = process.env.E2E_ARTIFACTS ?? './artifacts';
  return `${base}/${name}`;
}
