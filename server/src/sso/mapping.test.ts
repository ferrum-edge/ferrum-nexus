/**
 * Claim mapping in isolation: which role and organization a set of claims
 * maps to, what a sign-in changes on the account — and that `super_admin` is
 * never granted, removed or touched from a claim.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SSO_MAPPABLE_ROLES, type SsoProviderSettings } from '@ferrum-nexus/shared';

import { ssoProviderSettingsSchema } from './config.js';
import {
  claimValues,
  displayNameFromClaims,
  emailDomainAllowed,
  emailVerifiedClaim,
  mapClaims,
  normalizeEmailClaim,
  planClaimsChange,
} from './mapping.js';

function provider(overrides: Partial<SsoProviderSettings> = {}): SsoProviderSettings {
  return {
    id: 'corp',
    display_name: 'Corporate SSO',
    issuer: 'https://idp.example.com',
    client_id: 'nexus',
    scopes: ['openid', 'email', 'profile'],
    enabled: true,
    jit_provisioning: true,
    link_existing_accounts: true,
    require_verified_email: true,
    allowed_email_domains: [],
    disable_local_password_for_linked: false,
    sync_roles: true,
    default_role: 'client',
    role_mappings: [
      { claim: 'groups', value: 'api-publishers', role: 'provider' },
      { claim: 'groups', value: 'portal-admins', role: 'admin' },
      { claim: 'realm_access.roles', value: 'nexus-provider', role: 'provider' },
    ],
    org_mappings: [],
    ...overrides,
  };
}

describe('claimValues', () => {
  it('reads strings, arrays, scalars, nested paths and namespaced claim names', () => {
    const claims = {
      groups: ['a', 'b', 7, { nested: 'ignored' }],
      team: 'payments',
      admin: true,
      realm_access: { roles: ['nexus-provider'] },
      'https://example.com/groups': ['namespaced'],
    };
    assert.deepEqual(claimValues(claims, 'groups'), ['a', 'b', '7']);
    assert.deepEqual(claimValues(claims, 'team'), ['payments']);
    assert.deepEqual(claimValues(claims, 'admin'), ['true']);
    assert.deepEqual(claimValues(claims, 'realm_access.roles'), ['nexus-provider']);
    assert.deepEqual(claimValues(claims, 'https://example.com/groups'), ['namespaced']);
    assert.deepEqual(claimValues(claims, 'missing'), []);
    assert.deepEqual(claimValues(claims, 'realm_access.missing.deeper'), []);
    // An inherited property is not a claim.
    assert.deepEqual(claimValues(claims, 'constructor'), []);
    assert.deepEqual(claimValues(claims, 'team.length'), []);
  });
});

describe('mapClaims', () => {
  it('grants the highest role any rule matches', () => {
    const mapped = mapClaims(provider(), { groups: ['api-publishers', 'portal-admins'] });
    assert.equal(mapped.role, 'admin');
    assert.equal(mapped.roleMapping?.value, 'portal-admins');
  });

  it('matches nested claim paths', () => {
    const mapped = mapClaims(provider(), { realm_access: { roles: ['nexus-provider'] } });
    assert.equal(mapped.role, 'provider');
  });

  it('falls back to the default role, or to no access when there is none', () => {
    assert.equal(mapClaims(provider(), { groups: ['unrelated'] }).role, 'client');
    assert.equal(mapClaims(provider(), {}).roleMapping, null);
    const strict = provider({ default_role: null });
    assert.equal(mapClaims(strict, { groups: ['unrelated'] }).role, null);
    assert.equal(mapClaims(strict, { groups: ['api-publishers'] }).role, 'provider');
  });

  it('compares values exactly', () => {
    assert.equal(mapClaims(provider(), { groups: ['Portal-Admins'] }).role, 'client');
    assert.equal(mapClaims(provider(), { groups: 'portal-admins-x' }).role, 'client');
  });

  it('maps organizations only when the provider has organization rules', () => {
    assert.equal(mapClaims(provider(), { groups: ['x'] }).orgId, undefined);
    const withOrgs = provider({
      org_mappings: [
        { claim: 'department', value: 'payments', org_id: 'org-payments' },
        { claim: 'groups', value: 'payments-team', org_id: 'org-payments-2' },
      ],
    });
    assert.equal(mapClaims(withOrgs, { department: 'payments' }).orgId, 'org-payments');
    assert.equal(mapClaims(withOrgs, { groups: ['payments-team'] }).orgId, 'org-payments-2');
    const none = mapClaims(withOrgs, { department: 'sales' });
    assert.equal(none.orgId, null);
    assert.equal(none.orgMapping, null);
  });
});

describe('super_admin is never granted from claims', () => {
  it('is not a role a mapping can name', () => {
    assert.equal((SSO_MAPPABLE_ROLES as readonly string[]).includes('super_admin'), false);
    const attempt = {
      ...provider(),
      role_mappings: [{ claim: 'groups', value: 'root', role: 'super_admin' }],
    };
    assert.equal(ssoProviderSettingsSchema.safeParse(attempt).success, false);
    assert.equal(
      ssoProviderSettingsSchema.safeParse({ ...provider(), default_role: 'super_admin' }).success,
      false,
    );
  });

  it('never changes an account that already is one — not its role, not its organization', () => {
    const settings = provider({
      org_mappings: [{ claim: 'department', value: 'payments', org_id: 'org-payments' }],
    });
    const founder = { role: 'super_admin', org_id: null } as const;
    const demoting = mapClaims(settings, { groups: [], department: 'payments' });
    assert.equal(planClaimsChange(founder, demoting, settings, true), null);
    const denied = mapClaims(provider({ default_role: null }), {});
    assert.equal(denied.role, null);
    assert.equal(planClaimsChange(founder, denied, settings, true), null);
  });

  it('can grant admin, and take it away again, from claims', () => {
    const settings = provider();
    const promoted = planClaimsChange(
      { role: 'client', org_id: null },
      mapClaims(settings, { groups: ['portal-admins'] }),
      settings,
      false,
    );
    assert.deepEqual(promoted, { role: 'admin' });
    const demoted = planClaimsChange(
      { role: 'admin', org_id: null },
      mapClaims(settings, { groups: ['api-publishers'] }),
      settings,
      false,
    );
    assert.deepEqual(demoted, { role: 'provider' });
  });
});

describe('planClaimsChange', () => {
  it('changes nothing when the account already matches', () => {
    const settings = provider();
    const mapped = mapClaims(settings, { groups: ['api-publishers'] });
    assert.equal(planClaimsChange({ role: 'provider', org_id: 'o' }, mapped, settings, true), null);
  });

  it('leaves the role alone when the provider does not sync roles', () => {
    const settings = provider({ sync_roles: false });
    const mapped = mapClaims(settings, { groups: ['portal-admins'] });
    assert.equal(planClaimsChange({ role: 'client', org_id: null }, mapped, settings, true), null);
  });

  it('moves the organization, and clears it when the mapped one is gone', () => {
    const settings = provider({
      default_role: 'client',
      org_mappings: [{ claim: 'department', value: 'payments', org_id: 'org-payments' }],
    });
    const mapped = mapClaims(settings, { department: 'payments' });
    assert.deepEqual(planClaimsChange({ role: 'client', org_id: null }, mapped, settings, true), {
      org_id: 'org-payments',
    });
    assert.deepEqual(
      planClaimsChange({ role: 'client', org_id: 'org-payments' }, mapped, settings, false),
      { org_id: null },
    );
    const unmatched = mapClaims(settings, { department: 'sales' });
    assert.deepEqual(
      planClaimsChange({ role: 'client', org_id: 'org-payments' }, unmatched, settings, true),
      { org_id: null },
    );
  });
});

describe('email claims', () => {
  it('normalizes the address and refuses what is not one', () => {
    assert.equal(normalizeEmailClaim('  Alice@Example.COM '), 'alice@example.com');
    assert.equal(normalizeEmailClaim('not-an-address'), null);
    assert.equal(normalizeEmailClaim('two@@example.com'), null);
    assert.equal(normalizeEmailClaim(42), null);
    assert.equal(normalizeEmailClaim(undefined), null);
    assert.equal(normalizeEmailClaim(`${'a'.repeat(320)}@example.com`), null);
  });

  it('counts only the JSON boolean true as verified', () => {
    assert.equal(emailVerifiedClaim(true), true);
    for (const value of ['true', 1, 'yes', undefined, null, false]) {
      assert.equal(emailVerifiedClaim(value), false, String(value));
    }
  });

  it('matches allowed domains exactly', () => {
    assert.equal(emailDomainAllowed('a@example.com', []), true);
    assert.equal(emailDomainAllowed('a@example.com', ['example.com']), true);
    assert.equal(emailDomainAllowed('a@sub.example.com', ['example.com']), false);
    assert.equal(emailDomainAllowed('a@example.com.evil.test', ['example.com']), false);
    assert.equal(emailDomainAllowed('a@evil.test', ['example.com', 'example.org']), false);
  });

  it('derives a display name from the claims', () => {
    assert.equal(displayNameFromClaims({ name: ' Alice Doe ' }, 'a@example.com'), 'Alice Doe');
    assert.equal(displayNameFromClaims({ preferred_username: 'adoe' }, 'a@example.com'), 'adoe');
    assert.equal(displayNameFromClaims({}, 'alice@example.com'), 'alice');
  });
});
