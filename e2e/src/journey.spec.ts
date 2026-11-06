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

import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  MAIL_FROM,
  adminSession,
  clearMail,
  latestMailTo,
  portal,
  waitForStack,
} from './harness.js';

const EMAIL = /email/i;
const LEADING_PASSWORD_LABEL = /^password/i;
const DISPLAY_NAME_OR_NAME = /display name|name/i;
const CREATE_ACCOUNT_OR_SIGN_UP = /create account|register|sign up/i;
const VERIFY_YOUR_EMAIL = /verify|check your (email|inbox)/i;
const VERIFICATION_LINK = /https?:\/\/[^\s"'<>]*verify-email\?token=[A-Za-z0-9._~-]+/;
const VERIFIED_OR_SIGN_IN = /verified|sign in|log in/i;
const PASSWORD_LABEL = /password/i;
const SIGN_IN_OR_LOG_IN = /sign in|log in/i;
const API_CATALOG = /api catalog/i;
const DOCUMENTATION = /documentation/i;
const LIST_INVOICES = /list invoices/i;
const ACCESS = /access/i;
const WHY_DO_YOU_NEED_ACCESS = /why do you need access/i;
const REQUEST_ACCESS = /request access/i;
const PENDING_OR_WITHDRAW = /pending|withdraw request/i;
const MY_APIS = /my apis/i;
const REQUESTS = /requests/i;
const APPROVE = /^approve$/i;
const APPROVED_YOU_HAVE_ACCESS = /approved|you have access|call this api/i;

const RUN = Date.now().toString(36);
const PASSWORD = ADMIN_PASSWORD;
const CLIENT = `journey-client-${RUN}@example.test`;
const API_SLUG = `journey-${RUN}`;
const JOURNEY_BILLING_LINK = new RegExp(`Journey Billing ${RUN}`, 'i');
const CATALOG_ENTRY_URL = new RegExp(`/catalog/${API_SLUG}`);

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
   *
   * The operator account is the one `prepare.ts` bootstrapped — it also turned
   * email verification on, which is what makes the mail step below real.
   */
  const providerSession = await adminSession();
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
  await fill(page, EMAIL, CLIENT);
  await fill(page, LEADING_PASSWORD_LABEL, PASSWORD);
  await fill(page, DISPLAY_NAME_OR_NAME, 'Journey Client');
  await page.getByRole('button', { name: CREATE_ACCOUNT_OR_SIGN_UP }).click();

  // The portal says what it is waiting for rather than signing them straight in.
  await expect(page.getByText(VERIFY_YOUR_EMAIL).first()).toBeVisible();

  /* ── Verify by following the real link ────────────────────────────────── */

  const mail = await latestMailTo(CLIENT);
  expect(mail.from, 'the configured NEXUS_EMAIL_FROM sender').toBe(MAIL_FROM);
  const link = VERIFICATION_LINK.exec(mail.text)?.[0];
  expect(link, `no verification link in the mail to ${CLIENT}`).toBeTruthy();
  await page.goto(link as string);
  await expect(page.getByText(VERIFIED_OR_SIGN_IN).first()).toBeVisible();

  /* ── Sign in ──────────────────────────────────────────────────────────── */

  await page.goto('/login');
  await fill(page, EMAIL, CLIENT);
  await fill(page, PASSWORD_LABEL, PASSWORD);
  await page.getByRole('button', { name: SIGN_IN_OR_LOG_IN }).click();
  await expect(page.getByRole('link', { name: API_CATALOG })).toBeVisible({ timeout: 30_000 });

  /* ── Find the API and read its documentation ──────────────────────────── */

  await page.goto('/catalog');
  await page.getByRole('link', { name: JOURNEY_BILLING_LINK }).click();
  await expect(page).toHaveURL(CATALOG_ENTRY_URL);

  // The rendered documentation, not the raw upload: a catalog entry whose docs
  // do not render is not a catalog entry, and rendering it is the step the
  // HTTP suite cannot speak for.
  await page.getByRole('tab', { name: DOCUMENTATION }).click();
  await expect(page.getByText('/invoices').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(LIST_INVOICES).first()).toBeVisible();

  /* ── Request access ───────────────────────────────────────────────────── */

  await page.getByRole('tab', { name: ACCESS }).click();
  await fill(page, WHY_DO_YOU_NEED_ACCESS, 'Reconciling invoices for the journey test.');
  await page.getByRole('button', { name: REQUEST_ACCESS }).click();
  await expect(page.getByText(PENDING_OR_WITHDRAW).first()).toBeVisible();

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
  await providerPage.getByLabel(EMAIL).first().fill(ADMIN_EMAIL);
  await providerPage.getByLabel(PASSWORD_LABEL).first().fill(PASSWORD);
  await providerPage.getByRole('button', { name: SIGN_IN_OR_LOG_IN }).click();
  // Wait for the shell before navigating: a `goto` issued while the sign-in is
  // still in flight lands on a page the route guard bounces, and the failure
  // then reads as "the tab is missing" rather than "we were not signed in".
  await expect(providerPage.getByRole('link', { name: MY_APIS })).toBeVisible({
    timeout: 30_000,
  });
  // Straight to the API's page: reaching it from the list is the provider's
  // own navigation and has its own coverage, and the journey under test is the
  // client's. A bookmark gets here the same way.
  await providerPage.goto(`/apis/${published.api.id}`);
  await providerPage.getByRole('tab', { name: REQUESTS }).click();
  await expect(providerPage.getByText(CLIENT).first()).toBeVisible({ timeout: 30_000 });
  await providerPage.getByRole('button', { name: APPROVE }).first().click();

  // The decision is confirmed in a dialog, because approving grants live
  // gateway access.
  const confirm = providerPage.getByRole('dialog');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: APPROVE }).click();
  await expect(confirm).toBeHidden();

  await providerContext.close();

  /* ── The client sees the decision ─────────────────────────────────────── */

  await page.reload();
  await page.getByRole('tab', { name: ACCESS }).click();
  await expect(page.getByText(APPROVED_YOU_HAVE_ACCESS).first()).toBeVisible({
    timeout: 30_000,
  });
});
