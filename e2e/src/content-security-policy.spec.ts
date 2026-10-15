/**
 * A strict `style-src` in a real browser, against the packaged application
 * (issue #587).
 *
 * The SPA shell's policy has no `style-src 'unsafe-inline'`. Radix still
 * injects <style> elements at runtime: the scroll lock behind every Dialog,
 * Select and DropdownMenu, and the Select viewport's own rules. They must
 * carry the shell's per-response nonce, or the browser drops them and fires a
 * `securitypolicyviolation`. The HTTP suite cannot see that, so this opens all
 * three primitives and requires that their styles applied and that no
 * violation fired.
 */

import { expect, test, type Page } from '@playwright/test';

import { ADMIN_EMAIL, ADMIN_PASSWORD, waitForStack } from './harness.js';

type ViolationWindow = Window & { __cspViolations?: string[] };

/** The style-src directive of a response's policy. */
function styleSrc(policy: string | undefined): string {
  const directive = (policy ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('style-src '));
  expect(directive, "the shell's policy has a style-src directive").toBeTruthy();
  return directive as string;
}

/** The scroll lock's injected <style> applied: the body is locked and hidden. */
async function expectScrollLockApplied(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.body.hasAttribute('data-scroll-locked')
          ? getComputedStyle(document.body).overflow
          : 'not locked',
      ),
    )
    .toBe('hidden');
}

test.beforeAll(async () => {
  await waitForStack();
});

test("Radix's runtime styles apply under a style-src with no unsafe-inline", async ({ page }) => {
  // Recorded from the first script on, before the app can inject anything.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as ViolationWindow).__cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.effectiveDirective}: ${event.blockedURI} ${event.sample}`.trim());
    });
  });
  const consoleViolations: string[] = [];
  page.on('console', (message) => {
    if (/content security policy/i.test(message.text())) consoleViolations.push(message.text());
  });

  await page.goto('/login');
  await page.getByLabel(/email/i).first().fill(ADMIN_EMAIL);
  await page
    .getByLabel(/password/i)
    .first()
    .fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page.getByRole('link', { name: /my apis/i })).toBeVisible({ timeout: 30_000 });

  const response = await page.goto('/admin/users');
  expect(response?.status()).toBe(200);
  const policy = styleSrc(response?.headers()['content-security-policy']);
  expect(policy).not.toContain("'unsafe-inline'");
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  expect(nonce, 'style-src names a per-response nonce').toBeTruthy();
  // The shell hands the app the same nonce the header names.
  await expect
    .poll(() =>
      page.locator('meta[property="csp-nonce"]').evaluate((meta: HTMLMetaElement) => meta.nonce),
    )
    .toBe(nonce);

  // DropdownMenu: the account menu, behind the scroll lock.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expectScrollLockApplied(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  // Select: the scroll lock, and the viewport's own <style>.
  await page.getByRole('combobox', { name: 'Filter by role' }).click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await expectScrollLockApplied(page);
  await expect
    .poll(() =>
      page
        .locator('[data-radix-select-viewport]')
        .evaluate((viewport) => getComputedStyle(viewport).scrollbarWidth),
    )
    .toBe('none');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);

  // Dialog: a user's edit dialog, closed without saving.
  await page
    .getByRole('button', { name: /^Edit / })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectScrollLockApplied(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  expect(
    await page.evaluate(() => (window as ViolationWindow).__cspViolations),
    'no securitypolicyviolation fired',
  ).toEqual([]);
  expect(consoleViolations, 'no CSP violation was logged').toEqual([]);
});
