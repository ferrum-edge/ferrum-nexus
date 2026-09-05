import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import Fastify from 'fastify';
import { z } from 'zod';

import { loadConfig } from '../config/index.js';
import { parseOrThrow, registerErrorHandler } from '../middleware/error-handler.js';
import { buildLoggerOptions } from './logger.js';

interface LogRecord {
  msg: string;
  req?: { method: string; url: string };
  url?: string;
  res?: { statusCode: number };
  headers?: { cookie: string; authorization: string };
}

describe('structured request logs', () => {
  for (const token of ['SYNTHETIC', 'SYNTHETIC/with+reserved=characters']) {
    for (const encoded of [false, true]) {
      const label = `reserved=${token !== 'SYNTHETIC'}, encoded=${encoded}`;
      it(`redacts navigation and error URLs (${label})`, async (t) => {
        const lines: string[] = [];
        const options = buildLoggerOptions(
          loadConfig({
            NEXUS_SECRET_KEY: 'synthetic-secret-key-0123456789abcdef',
            FERRUM_ADMIN_JWT_SECRET: 'synthetic-admin-secret-0123456789abcdef',
            NEXUS_LOG_LEVEL: 'debug',
          }),
        );
        assert.ok(options && typeof options === 'object');
        const app = Fastify({
          logger: { ...options, stream: { write: (line: string) => lines.push(line) } },
        });
        t.after(() => app.close());
        // Exercise the production not-found handler's SPA navigation branch.
        registerErrorHandler(app, {
          spaFallback: (_request, reply) => reply.type('text/html').send('<html>SPA</html>'),
        });
        app.get('/api/validation', (request) => {
          return parseOrThrow(z.object({ limit: z.coerce.number().int() }), request.query);
        });
        app.get('/api/unexpected', () => {
          throw new Error('Synthetic unexpected failure');
        });
        app.get('/api/catalog', () => ({ items: [] }));

        // Encode every byte so even an alphanumeric bearer token has a distinct
        // encoded representation, and encode the parameter name too.
        const encodedToken = Array.from(token, (char) => {
          return `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
        }).join('');
        const value = encoded ? encodedToken : token;
        const query = `token=${value}&%74oken=${value}&limit=invalid`;
        for (const [path, status] of [
          ['/reset-password', 200],
          ['/verify-email', 200],
          ['/api/validation', 400],
          ['/api/unexpected', 500],
        ] as const) {
          lines.length = 0;
          const response = await app.inject({
            url: `${path}?${query}`,
            headers: { cookie: 'session=SYNTHETIC_COOKIE', authorization: 'Bearer SYNTHETIC_AUTH' },
          });
          assert.equal(response.statusCode, status);
          if (status === 200) {
            assert.match(response.headers['content-type'] ?? '', /text\/html/);
            assert.equal(response.body, '<html>SPA</html>');
          }
          assert.ok(lines.length > 0);
          for (const line of lines) {
            for (const secret of [
              token,
              encodedToken,
              encodeURIComponent(token),
              'SYNTHETIC_COOKIE',
              'SYNTHETIC_AUTH',
            ]) {
              assert.ok(!line.includes(secret), 'structured log must not contain a secret');
            }
          }
          const records = lines.map((line) => JSON.parse(line) as LogRecord);
          const sanitized = `${path}?token=[Redacted]&%74oken=[Redacted]&limit=invalid`;
          assert.equal(
            records.find((record) => record.msg === 'incoming request')?.req?.url,
            sanitized,
          );
          assert.equal(
            records.find((record) => record.msg === 'request completed')?.res?.statusCode,
            status,
          );
          if (status >= 400) {
            const message = status === 500 ? 'Unhandled server error' : 'Request failed';
            assert.equal(records.find((record) => record.msg === message)?.url, sanitized);
          }
        }

        lines.length = 0;
        await app.inject('/api/catalog?limit=20');
        const records = lines.map((line) => JSON.parse(line) as LogRecord);
        assert.deepEqual(records.find((record) => record.msg === 'incoming request')?.req, {
          method: 'GET',
          url: '/api/catalog?limit=20',
          ip: '127.0.0.1',
        });

        lines.length = 0;
        app.log.info({ headers: { cookie: 'SYNTHETIC_COOKIE', authorization: 'SYNTHETIC_AUTH' } });
        const headerRecord = JSON.parse(lines[0]!) as LogRecord;
        assert.deepEqual(headerRecord.headers, {
          cookie: '[Redacted]',
          authorization: '[Redacted]',
        });
      });
    }
  }
});
