/**
 * Bootstrap the portal once, before either suite runs.
 *
 * Both suites need an administrator: the data-plane matrix publishes APIs and
 * approves access, and the browser journey needs email verification turned on.
 * Only the **first** registration becomes `super_admin`, so whichever suite ran
 * second used to find itself an ordinary provider and fail on the first admin
 * call — a real failure of `run.sh all`, and one the halves could not fix
 * individually because they are separate processes against one stack.
 *
 * So the bootstrap happens here, once, the way an operator does it: register
 * the first account with the bootstrap token, then set the registration policy
 * the suites are written against. Both suites then simply sign in.
 *
 * Idempotent, so a re-run against a stack left up with `E2E_KEEP=1` works: an
 * address that is already registered signs in instead.
 */

import { ADMIN_EMAIL, ADMIN_PASSWORD, portal, portalRaw, signIn, waitForStack } from './harness.js';

async function main(): Promise<void> {
  await waitForStack();

  const registered = await portalRaw('POST', '/api/auth/register', {
    body: {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      display_name: 'E2E Operator',
      role: 'provider',
      bootstrap_token: process.env.NEXUS_BOOTSTRAP_TOKEN ?? '',
    },
  });

  if (registered.status === 201) {
    const body = (await registered.json()) as { user: { role: string } };
    if (body.user.role !== 'super_admin') {
      throw new Error(
        `The first registration came back as '${body.user.role}', not 'super_admin'. ` +
          'The portal was not empty — bring the stack down with `docker compose down -v` ' +
          'and run again.',
      );
    }
  } else if (registered.status !== 409) {
    throw new Error(
      `Bootstrapping the portal failed with ${registered.status}: ${await registered.text()}`,
    );
  }

  const admin = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (admin.role !== 'super_admin') {
    throw new Error(`The bootstrap account signed in as '${admin.role}', not 'super_admin'`);
  }

  // The policy both suites are written against: accounts created from here on
  // verify by email, which is what makes the journey's mail step real.
  await portal('PUT', '/api/admin/settings', {
    session: admin,
    body: { registration: { require_email_verification: true } },
    expect: 200,
  });

  process.stdout.write(`portal bootstrapped as ${ADMIN_EMAIL}\n`);
}

await main();
