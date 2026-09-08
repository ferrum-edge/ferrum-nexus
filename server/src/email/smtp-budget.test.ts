/**
 * The per-attempt deadline, and what a cut-off attempt means.
 *
 * Nodemailer's three timeouts are per-phase — `socketTimeout` is inactivity
 * *between* reads — so they do not compose into a ceiling on one `send`. A relay
 * that answers every command just inside them can hold an attempt open for
 * minutes, past the outbox's stale threshold, at which point another worker
 * reclaims a row that is still in flight and the recipient gets two copies.
 * `OUTBOX_SEND_BUDGET_MS` used to be a comment asserting that could not happen;
 * these cases drive a real TCP relay to show it is now a bound.
 *
 * The second question each case answers is what the cut-off *means*. SMTP hands
 * a message over at the end-of-data marker: before it, nothing was delivered and
 * a retry is safe; after it, the relay may have queued the message and a retry
 * is a duplicate. The budget is deliberately tiny here so the assertions are
 * about behaviour rather than about waiting.
 */

import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { after, describe, it } from 'node:test';

import {
  createSmtpTransport,
  isDeliveredUnacknowledged,
  type MailTransport,
  type OutboundMail,
  type ResolvedSmtpSettings,
} from './service.js';

const MAIL: OutboundMail = {
  to: 'reader@example.test',
  subject: 'Nexus budget probe',
  html: '<p>Bounded delivery</p>',
  text: 'Bounded delivery',
};

/** How the relay should misbehave. */
interface RelayOptions {
  /** Wait this long before answering anything, including the greeting. */
  commandDelayMs?: number;
  /** Take the whole message and then never acknowledge it. */
  stallAfterData?: boolean;
  /** Refuse the message after end-of-data with a permanent error. */
  rejectAfterData?: boolean;
}

/** A minimal SMTP sink. No mail leaves the process. */
interface Relay {
  port: number;
  /** Messages received in full, i.e. the relay saw the end-of-data marker. */
  received: string[];
  close(): Promise<void>;
}

async function startRelay(options: RelayOptions = {}): Promise<Relay> {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    // A stalled conversation must not outlive the case that created it.
    socket.setTimeout(10_000, () => socket.destroy());
    socket.setEncoding('utf8');

    let buffer = '';
    let inData = false;
    const reply = (line: string): void => {
      const delay = options.commandDelayMs ?? 0;
      const write = (): void => {
        if (!socket.destroyed) socket.write(line);
      };
      if (delay > 0) setTimeout(write, delay).unref();
      else write();
    };
    const step = (): void => {
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end === -1) return;
        received.push(buffer.slice(0, end));
        buffer = buffer.slice(end + 5);
        inData = false;
        // A relay that holds the message and goes quiet is the shape that used
        // to look identical to one that never received it at all.
        if (options.stallAfterData) return;
        reply(options.rejectAfterData ? '550 5.7.1 message rejected\r\n' : '250 2.0.0 queued\r\n');
        step();
        return;
      }
      const end = buffer.indexOf('\r\n');
      if (end === -1) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const command = line.split(/[\s:]/)[0]?.toUpperCase() ?? '';
      if (command === 'EHLO' || command === 'HELO') reply('250 nexus-budget-fixture\r\n');
      else if (command === 'DATA') {
        reply('354 send message\r\n');
        inData = true;
      } else if (command === 'QUIT') reply('221 2.0.0 goodbye\r\n');
      else reply('250 2.0.0 ok\r\n');
      step();
    };

    reply('220 nexus-budget-fixture ESMTP ready\r\n');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      step();
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
    received,
    close: async (): Promise<void> => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function settingsFor(port: number): ResolvedSmtpSettings {
  return {
    host: '127.0.0.1',
    port,
    secure: false,
    user: null,
    password: null,
    from: 'Nexus Relay <portal@example.test>',
  };
}

/** Everything a case opened, torn down whatever it asserted. */
const opened: { relay: Relay; transport: MailTransport }[] = [];

async function connect(options: RelayOptions, budgetMs: number): Promise<(typeof opened)[number]> {
  const relay = await startRelay(options);
  const pair = { relay, transport: createSmtpTransport(settingsFor(relay.port), { budgetMs }) };
  opened.push(pair);
  return pair;
}

/** The rejection reason, or `null` when the send succeeded. */
async function failureOf(transport: MailTransport, mail: OutboundMail): Promise<unknown> {
  return transport.send(mail).then(
    () => null,
    (reason: unknown) => reason,
  );
}

describe('SMTP send budget', { timeout: 30_000 }, () => {
  after(async () => {
    for (const { relay, transport } of opened) {
      await transport.close?.();
      await relay.close();
    }
  });

  it('leaves a well-behaved relay alone', async () => {
    const { relay, transport } = await connect({}, 5_000);
    await transport.send(MAIL);
    assert.equal(relay.received.length, 1);
    assert.match(relay.received[0] ?? '', /Subject: Nexus budget probe/);
  });

  it('bounds a relay that answers every command just inside the socket timeout', async () => {
    // 150 ms per command is nowhere near nodemailer's 30 s inactivity timeout,
    // so nothing it pins would ever fire: only the budget ends this attempt.
    const { relay, transport } = await connect({ commandDelayMs: 150 }, 250);

    const started = Date.now();
    const error = await failureOf(transport, MAIL);
    const elapsed = Date.now() - started;

    assert.ok(error instanceof Error, 'the attempt was cut off');
    assert.match(error.message, /budget/);
    assert.ok(elapsed < 5_000, `the send returned after ${elapsed}ms, not on the relay's schedule`);
    assert.equal(
      isDeliveredUnacknowledged(error),
      false,
      'nothing was written past DATA, so the retry loop is safe',
    );
    assert.deepEqual(relay.received, [], 'the relay never saw a complete message');
  });

  it('treats a stall after end-of-data as delivered-unacknowledged', async () => {
    const { relay, transport } = await connect({ stallAfterData: true }, 750);

    const error = await failureOf(transport, MAIL);

    assert.ok(error instanceof Error);
    assert.equal(
      isDeliveredUnacknowledged(error),
      true,
      `an unacknowledged delivery, not a failure: ${error.message}`,
    );
    assert.equal(relay.received.length, 1, 'the relay really did receive the whole message');
  });

  it('keeps a relay’s own rejection an ordinary failure', async () => {
    const { relay, transport } = await connect({ rejectAfterData: true }, 5_000);

    const error = await failureOf(transport, MAIL);

    assert.ok(error instanceof Error);
    assert.equal(
      isDeliveredUnacknowledged(error),
      false,
      'the relay answered and refused it; there is nothing queued to duplicate',
    );
    assert.equal(relay.received.length, 1);
  });
});
