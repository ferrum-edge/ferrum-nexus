import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sanitizeUrlForLog } from './sanitize-url-for-log.js';

describe('sanitizeUrlForLog', () => {
  it('preserves ordinary paths and diagnostic query strings verbatim', () => {
    for (const url of ['', '/', '/api/catalog', '/api/catalog?q=a%20b&limit=20&flag']) {
      assert.equal(sanitizeUrlForLog(url), url);
    }
  });

  it('redacts repeated, encoded and mixed-case parameter names without decoding values', () => {
    assert.equal(
      sanitizeUrlForLog('/reset-password?token=first&limit=20&%74oken=s%2Becret&TOKEN=last'),
      '/reset-password?token=[Redacted]&limit=20&%74oken=[Redacted]&TOKEN=[Redacted]',
    );
  });

  it('redacts common secret parameters, including empty values', () => {
    for (const name of [
      'token',
      'code',
      'state',
      'key',
      'secret',
      'signature',
      'access_token',
      'refresh_token',
      'api_key',
      'password',
    ]) {
      for (const value of ['', 'SYNTHETIC', 's%2Fecret', 'a=b=c']) {
        assert.equal(sanitizeUrlForLog(`/path?${name}=${value}`), `/path?${name}=[Redacted]`);
      }
    }
  });

  it('handles absolute and malformed URLs without throwing or leaking query values', () => {
    assert.equal(
      sanitizeUrlForLog('https://portal.test/verify-email?token=SYNTHETIC&lang=en'),
      'https://portal.test/verify-email?token=[Redacted]&lang=en',
    );
    assert.equal(
      sanitizeUrlForLog('/bad%path?%to%ken=SYNTHETIC&token=%ZZ&&page=2&'),
      '/bad%path?%to%ken=[Redacted]&token=[Redacted]&&page=2&',
    );
    assert.equal(sanitizeUrlForLog('/path?token&token=x'), '/path?token&token=[Redacted]');
  });
});
