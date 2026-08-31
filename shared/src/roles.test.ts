import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ELEVATED_ROLES,
  REGISTRABLE_ROLES,
  ROLE_LABELS,
  ROLE_ORDER,
  isRegistrableRole,
  isRole,
  roleAtLeast,
  roleRank,
  type Role,
} from './roles.js';

describe('ROLE_ORDER', () => {
  it('is strictly ordered from client to super_admin', () => {
    assert.deepEqual([...ROLE_ORDER], ['client', 'provider', 'admin', 'super_admin']);
  });

  it('has a label for every role', () => {
    for (const role of ROLE_ORDER) {
      assert.equal(typeof ROLE_LABELS[role], 'string');
      assert.ok(ROLE_LABELS[role].length > 0);
    }
  });

  it('partitions cleanly into registrable and elevated roles', () => {
    const union = [...REGISTRABLE_ROLES, ...ELEVATED_ROLES].sort();
    assert.deepEqual(union, [...ROLE_ORDER].sort());
  });
});

describe('roleRank', () => {
  it('ranks roles by index in ROLE_ORDER', () => {
    assert.equal(roleRank('client'), 0);
    assert.equal(roleRank('provider'), 1);
    assert.equal(roleRank('admin'), 2);
    assert.equal(roleRank('super_admin'), 3);
  });
});

describe('roleAtLeast', () => {
  it('is reflexive for every role', () => {
    for (const role of ROLE_ORDER) {
      assert.equal(roleAtLeast(role, role), true, `${role} should satisfy itself`);
    }
  });

  it('lets higher roles inherit lower capabilities', () => {
    assert.equal(roleAtLeast('super_admin', 'client'), true);
    assert.equal(roleAtLeast('admin', 'provider'), true);
    assert.equal(roleAtLeast('provider', 'client'), true);
  });

  it('refuses lower roles', () => {
    assert.equal(roleAtLeast('client', 'provider'), false);
    assert.equal(roleAtLeast('provider', 'admin'), false);
    assert.equal(roleAtLeast('admin', 'super_admin'), false);
  });

  it('is transitive across the whole ladder', () => {
    for (let i = 0; i < ROLE_ORDER.length; i += 1) {
      for (let j = 0; j < ROLE_ORDER.length; j += 1) {
        const a = ROLE_ORDER[i] as Role;
        const b = ROLE_ORDER[j] as Role;
        assert.equal(roleAtLeast(a, b), i >= j, `roleAtLeast(${a}, ${b})`);
      }
    }
  });
});

describe('isRole', () => {
  it('accepts every known role', () => {
    for (const role of ROLE_ORDER) {
      assert.equal(isRole(role), true);
    }
  });

  it('rejects unknown or non-string values', () => {
    for (const value of ['owner', 'SUPER_ADMIN', '', null, undefined, 3, {}, ['client']]) {
      assert.equal(isRole(value), false, `${JSON.stringify(value)} is not a role`);
    }
  });
});

describe('isRegistrableRole', () => {
  it('accepts only client and provider', () => {
    assert.equal(isRegistrableRole('client'), true);
    assert.equal(isRegistrableRole('provider'), true);
    assert.equal(isRegistrableRole('admin'), false);
    assert.equal(isRegistrableRole('super_admin'), false);
    assert.equal(isRegistrableRole(null), false);
  });
});
