import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { ApiErrorBody, SmtpTestResponse } from '@ferrum-nexus/shared';

import { buildTestApp, type TestApp, type TestSession } from '../test/helpers.js';
import { createSmtpTransport, type MailTransport, type OutboundMail } from './service.js';

const USER = 'fixture-user';
const PASSWORD = 'fixture-password';
const FROM = 'Nexus Relay <portal@example.test>';
const MAIL: OutboundMail = {
  to: '"Reader, One" <reader+tag@example.test>',
  subject: 'Nexus delivery regression',
  html: '<p>HTML delivery marker</p>',
  text: 'Plain text delivery marker',
};

/** A loopback SMTP peer; the client is the actual production Nodemailer wrapper. */
async function startRelay() {
  const sockets = new Set<Socket>();
  const commands: string[] = [];
  const messages: string[] = [];
  const credentials: string[] = [];
  const state = { rejectRecipient: false };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(5_000, () => socket.destroy());
    socket.setEncoding('utf8');
    socket.write('220 nexus-fixture ESMTP ready\r\n');
    let pending = '';
    let data: string[] | null = null;
    socket.on('data', (chunk: string) => {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf('\r\n')) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (data !== null) {
          if (line === '.') {
            messages.push(data.join('\r\n'));
            data = null;
            socket.write('250 2.0.0 queued\r\n');
          } else {
            data.push(line.replace(/^\.\./, '.'));
          }
          continue;
        }
        commands.push(line);
        if (line.startsWith('EHLO ') || line.startsWith('HELO ')) {
          socket.write('250-nexus-fixture\r\n250 AUTH PLAIN\r\n');
        } else if (line.startsWith('AUTH PLAIN ')) {
          const credential = Buffer.from(line.slice('AUTH PLAIN '.length), 'base64').toString();
          credentials.push(credential);
          socket.write(
            credential === `\0${USER}\0${PASSWORD}`
              ? '235 2.7.0 authenticated\r\n'
              : '535 5.7.8 invalid credentials\r\n',
          );
        } else if (line.startsWith('MAIL FROM:')) {
          socket.write('250 2.1.0 sender accepted\r\n');
        } else if (line.startsWith('RCPT TO:')) {
          socket.write(
            state.rejectRecipient
              ? '550-5.1.1 recipient rejected\r\n550 5.1.1 fixture mailbox unavailable\r\n'
              : '250 2.1.5 recipient accepted\r\n',
          );
        } else if (line === 'DATA') {
          data = [];
          socket.write('354 send message\r\n');
        } else if (line === 'QUIT') {
          socket.end('221 2.0.0 goodbye\r\n');
        } else {
          socket.write('500 5.5.1 unsupported fixture command\r\n');
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    port: address.port,
    commands,
    messages,
    credentials,
    state,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe('real SMTP transport compatibility', { timeout: 30_000 }, () => {
  let relay: Awaited<ReturnType<typeof startRelay>>;
  let transport: MailTransport;
  let harness: TestApp;
  let admin: TestSession;

  before(async () => {
    relay = await startRelay();
    transport = createSmtpTransport({
      host: '127.0.0.1',
      port: relay.port,
      secure: false,
      user: USER,
      password: PASSWORD,
      from: FROM,
    });
    harness = await buildTestApp({
      env: {
        NEXUS_SMTP_HOST: '127.0.0.1',
        NEXUS_SMTP_PORT: String(relay.port),
        NEXUS_SMTP_SECURE: 'false',
        NEXUS_SMTP_USER: USER,
        NEXUS_SMTP_PASSWORD: PASSWORD,
        NEXUS_EMAIL_FROM: FROM,
      },
      // Explicitly remove the helper's recording transport so the composed
      // email service resolves its settings and creates the real SMTP client.
      deps: { mailTransportFactory: undefined },
    });
    admin = await harness.registerUser({ email: 'admin@example.test' });
  });

  beforeEach(() => {
    relay.commands.length = 0;
    relay.messages.length = 0;
    relay.credentials.length = 0;
    relay.state.rejectRecipient = false;
  });

  after(async () => {
    await transport?.close?.();
    await harness?.close();
    await relay?.close();
  });

  it('authenticates to the configured relay and delivers envelope and MIME fields', async () => {
    await transport.send(MAIL);
    assert.deepEqual(relay.credentials, [`\0${USER}\0${PASSWORD}`]);
    assert.ok(relay.commands.includes('MAIL FROM:<portal@example.test>'));
    assert.deepEqual(
      relay.commands.filter((line) => line.startsWith('RCPT TO:')),
      ['RCPT TO:<reader+tag@example.test>'],
    );
    assert.equal(relay.messages.length, 1);
    const message = relay.messages[0]!;
    assert.match(message, /^From: Nexus Relay <portal@example\.test>\r?$/m);
    assert.match(message, /^To: "Reader, One" <reader\+tag@example\.test>\r?$/m);
    assert.match(message, /^Subject: Nexus delivery regression\r?$/m);
    assert.match(message, /Content-Type: multipart\/alternative;/);
    assert.match(message, /Content-Type: text\/plain;/);
    assert.match(message, /Content-Type: text\/html;/);
    assert.ok(message.includes(MAIL.text));
    assert.ok(message.includes(MAIL.html));
    assert.equal(message.includes(PASSWORD), false);
  });

  it('preserves a quoted local part without redirecting its domain', async () => {
    await transport.send({ ...MAIL, to: '"user@other.test"@example.test' });
    assert.deepEqual(
      relay.commands.filter((line) => line.startsWith('RCPT TO:')),
      ['RCPT TO:<"user@other.test"@example.test>'],
    );
    assert.match(relay.messages[0]!, /^To: <"user@other\.test"@example\.test>\r?$/m);
  });

  it('bounds nested recipient parsing and remains usable after rejection', async () => {
    // This lower-level boundary deliberately bypasses Nexus's single-address
    // HTTP schema. The old parser would flatten all 80 groups and deliver.
    await assert.rejects(
      transport.send({ ...MAIL, to: `${'group: '.repeat(80)}reader@example.test;` }),
      { code: 'EENVELOPE' },
    );
    assert.equal(
      relay.commands.some((line) => line.startsWith('RCPT TO:')),
      false,
    );
    assert.equal(relay.messages.length, 0);
    await transport.send(MAIL);
    assert.equal(relay.messages.length, 1);
  });

  it('parses a multiline SMTP rejection and reports it through the admin probe', async () => {
    relay.state.rejectRecipient = true;
    await assert.rejects(transport.send(MAIL), (error: unknown) => {
      assert.ok(error instanceof Error);
      const smtpError = error as Error & { code: string; responseCode: number; command: string };
      assert.equal(smtpError.code, 'EENVELOPE');
      assert.equal(smtpError.responseCode, 550);
      assert.equal(smtpError.command, 'RCPT TO');
      assert.match(smtpError.message, /fixture mailbox unavailable/);
      return true;
    });
    const response = await harness.authed(admin, {
      method: 'POST',
      url: '/api/admin/settings/smtp-test',
      payload: { to_email: 'reader@example.test' },
    });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json<SmtpTestResponse>();
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /fixture mailbox unavailable/);
    assert.equal(response.body.includes(PASSWORD), false);
    assert.equal(relay.messages.length, 0);
  });

  it('validates recipient input before SMTP and delivers a valid admin probe', async () => {
    for (const to of [
      'group: reader@example.test;',
      'one@example.test,two@example.test',
      'one@example.test\r\nBcc: two@example.test',
      `${'a'.repeat(321)}@example.test`,
    ]) {
      const response = await harness.authed(admin, {
        method: 'POST',
        url: '/api/admin/settings/smtp-test',
        payload: { to_email: to },
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json<ApiErrorBody>().error.code, 'VALIDATION_FAILED');
    }
    assert.equal(relay.commands.length, 0);
    const response = await harness.authed(admin, {
      method: 'POST',
      url: '/api/admin/settings/smtp-test',
      payload: { to_email: 'reader+probe@example.test' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json<SmtpTestResponse>(), { ok: true, error: null });
    assert.equal(relay.messages.length, 1);
    assert.deepEqual(relay.credentials, [`\0${USER}\0${PASSWORD}`]);
    assert.ok(relay.commands.includes('MAIL FROM:<portal@example.test>'));
    assert.ok(relay.commands.includes('RCPT TO:<reader+probe@example.test>'));
    assert.match(relay.messages[0]!, /Subject: Ferrum Nexus SMTP test/);
  });
});
