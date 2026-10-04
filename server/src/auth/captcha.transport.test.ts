import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';

import { undiciCaptchaTransport } from './captcha.js';

interface CapturedRequest {
  path: string;
  method: string;
  version: string;
  type: string;
  body: string;
}

describe('CAPTCHA default transport', () => {
  it('sends the form over H1 and does not forward it to a redirect target', async (t) => {
    const requests: CapturedRequest[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({
        path: req.url ?? '',
        method: req.method ?? '',
        version: req.httpVersion,
        type: String(req.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/credential-sink' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });
    const origin = `http://127.0.0.1:${address.port}`;
    const form = new URLSearchParams({
      secret: 'test-vendor-secret',
      response: 'test token+value',
    });
    assert.deepEqual(await undiciCaptchaTransport(`${origin}/verify`, form), {
      success: true,
      errors: [],
    });
    assert.deepEqual(await undiciCaptchaTransport(`${origin}/redirect`, form), {
      success: false,
      errors: [],
    });
    assert.deepEqual(requests.map((request) => request.path), ['/verify', '/redirect']);
    for (const request of requests) {
      assert.equal(request.method, 'POST');
      assert.equal(request.version, '1.1');
      assert.equal(request.type, 'application/x-www-form-urlencoded');
      assert.equal(request.body, form.toString());
    }
  });
});
