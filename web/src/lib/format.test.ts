import { describe, expect, it } from 'vitest';
import { humanize } from './format';

describe('humanize', () => {
  it('turns snake_case and dotted identifiers into sentence case', () => {
    expect(humanize('auth.login')).toBe('Auth login');
    expect(humanize('message.thread_create')).toBe('Message thread create');
    expect(humanize('access_request')).toBe('Access request');
    expect(humanize('  user  ')).toBe('User');
    expect(humanize('')).toBe('');
  });

  it('spells acronyms in capitals wherever they fall', () => {
    expect(humanize('api')).toBe('API');
    expect(humanize('api.publish')).toBe('API publish');
    expect(humanize('god.delete_api')).toBe('God delete API');
    expect(humanize('api.auth_plugin_changed')).toBe('API auth plugin changed');
    expect(humanize('admin.smtp_test')).toBe('Admin SMTP test');
    expect(humanize('captcha_secret')).toBe('CAPTCHA secret');
    expect(humanize('acl_group')).toBe('ACL group');
    expect(humanize('jwt_auth')).toBe('JWT auth');
    expect(humanize('target_id')).toBe('Target ID');
    expect(humanize('invoke_url')).toBe('Invoke URL');
    expect(humanize('cors_origins')).toBe('CORS origins');
    expect(humanize('client_ip')).toBe('Client IP');
    expect(humanize('tls_verify')).toBe('TLS verify');
    expect(humanize('sso.login')).toBe('SSO login');
    expect(humanize('allowed_ids')).toBe('Allowed IDs');
  });

  it('leaves words that merely contain an acronym alone', () => {
    expect(humanize('rapid_ship')).toBe('Rapid ship');
    expect(humanize('identity.update')).toBe('Identity update');
    expect(humanize('description')).toBe('Description');
  });
});
