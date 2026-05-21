import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadConfig } from '../config/index.js';

const REQUIRED_ENV = {
  NEXUS_SECRET_KEY: 'a'.repeat(64),
  FERRUM_ADMIN_URL: 'http://127.0.0.1:8000',
  FERRUM_ADMIN_JWT_SECRET: 'b'.repeat(32),
};

test('loadConfig parses boolean env strings explicitly', () => {
  withEnv(
    {
      ...REQUIRED_ENV,
      NODE_ENV: 'development',
      NEXUS_SESSION_SECURE: 'false',
      NEXUS_SMTP_SECURE: 'false',
      NEXUS_TRUST_PROXY: 'true',
    },
    () => {
      const config = loadConfig();
      assert.equal(config.session.secure, false);
      assert.equal(config.email.smtpSecure, false);
      assert.equal(config.trustProxy, true);
    },
  );
});

test('loadConfig defaults secure cookies on in production', () => {
  withEnv({ ...REQUIRED_ENV, NODE_ENV: 'production', NEXUS_SESSION_SECURE: undefined }, () => {
    const config = loadConfig();
    assert.equal(config.session.secure, true);
  });
});

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    previous.set(key, process.env[key]);
  }
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
