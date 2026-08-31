import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACCESS_CONTROL_PLUGIN,
  AUTH_PLUGIN_LABELS,
  AUTH_PLUGIN_TYPES,
  CSRF_COOKIE,
  CSRF_HEADER,
  CSRF_HEADER_LOWER,
  DEFAULT_FERRUM_NAMESPACE,
  DEFAULT_PAGE_SIZE,
  EMAIL_TEMPLATE_KEYS,
  EMAIL_TEMPLATE_LABELS,
  MAX_PAGE_SIZE,
  SESSION_COOKIE,
  aclGroupForApi,
  apiIdFromAclGroup,
  clampPageSize,
  consumerUsernameForUser,
  isAuthPluginType,
  isEmailTemplateKey,
  listenPathFor,
  testConsumerUsername,
} from './constants.js';
import { ALL_ERROR_CODES, ERROR_CODES, ERROR_CODE_STATUS, isErrorCode } from './error-codes.js';

describe('Ferrum Edge naming helpers', () => {
  it('builds the approved ACL group for an API', () => {
    assert.equal(aclGroupForApi('a1b2'), 'nexus:api:a1b2:approved');
  });

  it('round-trips an API id through its ACL group', () => {
    const id = '4f0e2b2c-9c3a-4a1f-9c9d-2a0f2f7b1c11';
    assert.equal(apiIdFromAclGroup(aclGroupForApi(id)), id);
  });

  it('returns null for groups it does not own', () => {
    assert.equal(apiIdFromAclGroup('other:group'), null);
    assert.equal(apiIdFromAclGroup('nexus:api:abc'), null);
    assert.equal(apiIdFromAclGroup('nexus:api::approved'), null);
  });

  it('namespaces consumer usernames by purpose', () => {
    assert.equal(consumerUsernameForUser('u-1'), 'nexus-user-u-1');
    assert.equal(testConsumerUsername('api-1'), 'nexus-test-api-1');
    assert.notEqual(consumerUsernameForUser('x'), testConsumerUsername('x'));
  });

  it('builds the gateway listen path from namespace and slug', () => {
    assert.equal(listenPathFor(DEFAULT_FERRUM_NAMESPACE, 'billing'), '/nexus/billing');
  });
});

describe('cookies and headers', () => {
  it('uses the documented names', () => {
    assert.equal(SESSION_COOKIE, 'nexus_session');
    assert.equal(CSRF_COOKIE, 'nexus_csrf');
    assert.equal(CSRF_HEADER, 'X-Nexus-CSRF');
  });

  it('keeps the lowercased header in sync', () => {
    assert.equal(CSRF_HEADER_LOWER, CSRF_HEADER.toLowerCase());
  });
});

describe('auth plugins', () => {
  it('labels every plugin type', () => {
    for (const type of AUTH_PLUGIN_TYPES) {
      assert.equal(typeof AUTH_PLUGIN_LABELS[type], 'string');
    }
  });

  it('guards plugin types at runtime', () => {
    assert.equal(isAuthPluginType('key-auth'), true);
    assert.equal(isAuthPluginType('oauth2'), false);
    assert.equal(isAuthPluginType(undefined), false);
  });

  it('names the access control plugin used for requestable APIs', () => {
    assert.equal(ACCESS_CONTROL_PLUGIN, 'access_control');
  });
});

describe('email template keys', () => {
  it('covers every key from the data model', () => {
    assert.deepEqual([...EMAIL_TEMPLATE_KEYS].sort(), [
      'access_approved',
      'access_denied',
      'access_revoked',
      'credential_rotated',
      'mass',
      'message_received',
      'verification',
    ]);
  });

  it('labels every key and guards them at runtime', () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      assert.equal(typeof EMAIL_TEMPLATE_LABELS[key], 'string');
      assert.equal(isEmailTemplateKey(key), true);
    }
    assert.equal(isEmailTemplateKey('welcome'), false);
  });
});

describe('clampPageSize', () => {
  it('falls back to the default for missing or invalid input', () => {
    assert.equal(clampPageSize(undefined), DEFAULT_PAGE_SIZE);
    assert.equal(clampPageSize(Number.NaN), DEFAULT_PAGE_SIZE);
    assert.equal(clampPageSize(Number.POSITIVE_INFINITY), DEFAULT_PAGE_SIZE);
  });

  it('clamps into [1, MAX_PAGE_SIZE]', () => {
    assert.equal(clampPageSize(0), 1);
    assert.equal(clampPageSize(-10), 1);
    assert.equal(clampPageSize(10), 10);
    assert.equal(clampPageSize(MAX_PAGE_SIZE + 1), MAX_PAGE_SIZE);
  });

  it('floors fractional page sizes', () => {
    assert.equal(clampPageSize(10.9), 10);
  });
});

describe('error codes', () => {
  it('keys and values match, so codes are stable strings', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      assert.equal(key, value);
    }
  });

  it('assigns an HTTP status to every code', () => {
    for (const code of ALL_ERROR_CODES) {
      const status = ERROR_CODE_STATUS[code];
      assert.equal(typeof status, 'number');
      assert.ok(status >= 400 && status < 600, `${code} -> ${status}`);
    }
  });

  it('guards codes at runtime', () => {
    assert.equal(isErrorCode(ERROR_CODES.CSRF_MISMATCH), true);
    assert.equal(isErrorCode('TEAPOT'), false);
  });
});
