/**
 * The principal portal journey, in a real browser, against the packaged
 * application (issue #285).
 *
 * This is the half the HTTP suite cannot speak for: that a person can actually
 * complete the flow the product is for. It registers, verifies by following
 * the link out of a real email, browses the catalog, reads the rendered
 * documentation, requests access, and — as the provider — approves it.
 *
 * It deliberately stops before issuing a credential and calling the gateway:
 * the data-plane suite already proves that end, and doing it twice would make
 * the browser test slower without making it say more.
 */

import { expect, test, type Page } from '@playwright/test';

import { clearMail, latestMailTo, portal, waitForStack } from './harness.js';

const RUN = Date.now().toString(36);
const PASSWORD = 'correct-horse-battery-staple';
const PROVIDER = `journey-provider-${RUN}@example.test`;
const CLIENT = `journey-client-${RUN}@example.test`;
const API_SLUG = `journey-${RUN}`;

/** Fill a labelled field, matching the accessible name the SPA renders. */
async function fill(page: Page, label: RegExp | string, value: string): Promise<void> {
  await page.getByLabel(label).first().fill(value);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await waitForStack();
  await clearMail();
});

test('a client registers, verifies by email, finds an API and is approved', async ({
  page,
  browser,
}) => {
  /* ── The provider, and an API to find ──────────────────────────────────
   *
   * Set up through the API rather than the browser: the provider's publishing
   * flow has its own coverage, and what this test is about is the client's
   * journey. Doing it here keeps the browser steps to the ones under test.
   */
  const providerSession = await registerProvider();
  await portal('PUT', '/api/admin/settings', {
    session: providerSession,
    body: { registration: { require_email_verification: true } },
    expect: 200,
  });
  const published = await portal<{ api: { id: string } }>('POST', '/api/apis', {
    session: providerSession,
    body: {
      name: `Journey Billing ${RUN}`,
      slug: API_SLUG,
      spec: JSON.stringify({
        openapi: '3.1.0',
        info: { title: `Journey Billing ${RUN}`, version: '1.0.0' },
        servers: [{ url: process.env.E2E_UPSTREAM_URL ?? 'http://upstream:9100' }],
        paths: {
          '/invoices': {
            get: { summary: 'List invoices', responses: { '200': { description: 'OK' } } },
          },
        },
      }),
      auth_plugin: 'key_auth',
      requestable: true,
      visibility: 'public',
    },
  });

  /* ── Register in the browser ──────────────────────────────────────────── */

  await page.goto('/register');
  await fill(page, /email/i, CLIENT);
  await fill(page, /^password/i, PASSWORD);
  await fill(page, /display name|name/i, 'Journey Client');
  await page.getByRole('button', { name: /create account|register|sign up/i }).click();

  // The portal says what it is waiting for rather than signing them straight in.
  await expect(page.getByText(/verify|check your (email|inbox)/i).first()).toBeVisible();

  /* ── Verify by following the real link ────────────────────────────────── */

  const mail = await latestMailTo(CLIENT);
  const link = /https?:\/\/[^\s"'<>]*verify-email\?token=[A-Za-z0-9._~-]+/.exec(mail.text)?.[0];
  expect(link, `no verification link in the mail to ${CLIENT}`).toBeTruthy();
  await page.goto(link as string);
  await expect(page.getByText(/verified|sign in|log in/i).first()).toBeVisible();

  /* ── Sign in ──────────────────────────────────────────────────────────── */

  await page.goto('/login');
  await fill(page, /email/i, CLIENT);
  await fill(page, /password/i, PASSWORD);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page.getByRole('link', { name: /api catalog/i })).toBeVisible({ timeout: 30_000 });

  /* ── Find the API and read its documentation ──────────────────────────── */

  await page.goto('/catalog');
  await page.getByRole('link', { name: new RegExp(`Journey Billing ${RUN}`, 'i') }).click();
  await expect(page).toHaveURL(new RegExp(`/catalog/${API_SLUG}`));

  // The rendered documentation, not the raw upload: a catalog entry whose docs
  // do not render is not a catalog entry, and rendering it is the step the
  // HTTP suite cannot speak for.
  await page.getByRole('tab', { name: /documentation/i }).click();
  await expect(page.getByText('/invoices').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/list invoices/i).first()).toBeVisible();

  /* ── Request access ───────────────────────────────────────────────────── */

  await page.getByRole('tab', { name: /access/i }).click();
  await fill(page, /why do you need access/i, 'Reconciling invoices for the journey test.');
  await page.getByRole('button', { name: /request access/i }).click();
  await expect(page.getByText(/pending|withdraw request/i).first()).toBeVisible();

  /* ── The provider approves, in their own browser session ────────────────
   *
   * A separate context, not a second tab: the client is signed in, and a
   * session cookie is per-context. Two roles in one context is not a thing the
   * portal supports, and pretending otherwise would be testing the test.
   */
  const providerContext = await browser.newContext({
    baseURL: process.env.E2E_PORTAL_URL ?? 'http://127.0.0.1:8787',
  });
  const providerPage = await providerContext.newPage();
  await providerPage.goto('/login');
  await providerPage.getByLabel(/email/i).first().fill(PROVIDER);
  await providerPage
    .getByLabel(/password/i)
    .first()
    .fill(PASSWORD);
  await providerPage.getByRole('button', { name: /sign in|log in/i }).click();
  // Wait for the shell before navigating: a `goto` issued while the sign-in is
  // still in flight lands on a page the route guard bounces, and the failure
  // then reads as "the tab is missing" rather than "we were not signed in".
  await expect(providerPage.getByRole('link', { name: /my apis/i })).toBeVisible({
    timeout: 30_000,
  });
  // Straight to the API's page: reaching it from the list is the provider's
  // own navigation and has its own coverage, and the journey under test is the
  // client's. A bookmark gets here the same way.
  await providerPage.goto(`/apis/${published.api.id}`);
  await providerPage.getByRole('tab', { name: /requests/i }).click();
  await expect(providerPage.getByText(CLIENT).first()).toBeVisible({ timeout: 30_000 });
  await providerPage
    .getByRole('button', { name: /^approve$/i })
    .first()
    .click();

  // The decision is confirmed in a dialog, because approving grants live
  // gateway access.
  const confirm = providerPage.getByRole('dialog');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: /^approve$/i }).click();
  await expect(confirm).toBeHidden();

  await providerContext.close();

  /* ── The client sees the decision ─────────────────────────────────────── */

  await page.reload();
  await page.getByRole('tab', { name: /access/i }).click();
  await expect(page.getByText(/approved|you have access|call this api/i).first()).toBeVisible({
    timeout: 30_000,
  });
});

/** The bootstrap provider, through the API — not the journey under test. */
async function registerProvider(): Promise<import('./harness.js').Session> {
  const { registerVerifiedUser } = await import('./harness.js');
  return registerVerifiedUser(PROVIDER, 'provider', { bootstrap: true });
}
