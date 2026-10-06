/** Recipient writes and real SMTP cancellation fence address recovery on every store. */

import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { after, before, describe, it } from 'node:test';

import type { NexusStore, TransactionOptions } from '../db/store.js';
import { createOutboxWorker } from '../email/outbox-worker.js';
import { createSmtpTransport } from '../email/service.js';
import { isoInSeconds, newId } from '../lib/ids.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

interface MailTarget {
  store: NexusStore;
  teardown: () => Promise<void>;
  peer?: () => Promise<NexusStore>;
}

function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function interceptStore(base: NexusStore, hook: (store: NexusStore) => NexusStore): NexusStore {
  return new Proxy(hook(base), {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return <T>(fn: (tx: NexusStore) => Promise<T>, options?: TransactionOptions): Promise<T> =>
          base.transaction((tx) => fn(interceptStore(tx, hook)), options);
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(base) : value;
    },
  });
}

async function slowRelay() {
  const connected = barrier();
  const received: string[] = [];
  const sockets = new Set<Socket>();
  let slow = true;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    let data = false;
    const reply = (line: string): void => {
      const write = (): void => {
        if (!socket.destroyed) socket.write(line);
      };
      if (slow) setTimeout(write, 150).unref();
      else write();
    };
    connected.resolve();
    reply('220 lifecycle fixture ESMTP\r\n');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (data) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end === -1) return;
        received.push(buffer.slice(0, end));
        buffer = buffer.slice(end + 5);
        data = false;
        reply('250 queued\r\n');
      }
      let end: number;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (line.startsWith('EHLO') || line.startsWith('HELO')) reply('250 fixture\r\n');
        else if (line === 'DATA') {
          data = true;
          reply('354 send message\r\n');
          return;
        } else if (line === 'QUIT') socket.end('221 goodbye\r\n');
        else reply('250 ok\r\n');
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
    connected: connected.promise,
    received,
    speedUp(): void {
      slow = false;
    },
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export function runMailLifecycleContract(
  label: string,
  makeStore: () => Promise<MailTarget>,
): void {
  describe(`mail and address lifecycle — ${label}`, { timeout: 20_000 }, () => {
    let target: MailTarget;
    let peer: NexusStore;
    let h: TestApp;
    let other: TestApp;
    let founder: TestSession;
    let afterScan: (() => Promise<void>) | null = null;

    before(async () => {
      target = await makeStore();
      peer = target.peer ? await target.peer() : target.store;
      h = await buildTestApp({
        store: target.store,
        wrapStore: (base) =>
          interceptStore(base, (store) => {
            const outbox = new Proxy(store.emailOutbox, {
              get(repo, property) {
                if (property !== 'cancelForReleasedAddress') return Reflect.get(repo, property);
                return async (email: string): Promise<number> => {
                  const count = await repo.cancelForReleasedAddress(email);
                  const pause = afterScan;
                  afterScan = null;
                  await pause?.();
                  return count;
                };
              },
            });
            return new Proxy(store, {
              get(inner, property) {
                return property === 'emailOutbox' ? outbox : Reflect.get(inner, property);
              },
            });
          }),
      });
      other = await buildTestApp({ store: peer, edge: h.edge });
      founder = await h.registerUser({ email: 'mail-founder@example.test' });
    });

    after(async () => {
      await other?.close();
      await h?.close();
      if (peer && peer !== target.store) await peer.close();
      await target?.teardown();
    });

    async function disabledAccount(): Promise<TestSession> {
      const subject = await h.registerUser({ email: `${newId()}@example.test` });
      const disabled = await h.authed(founder, {
        method: 'PATCH',
        url: `/api/users/${subject.user.id}`,
        payload: { status: 'disabled' },
      });
      assert.equal(disabled.statusCode, 200, disabled.body);
      assert.equal((await peer.gatewayTeardownJobs.findByUser(subject.user.id))?.status, 'done');
      return subject;
    }

    function release(subject: TestSession) {
      return h.authed(founder, {
        method: 'POST',
        url: `/api/users/${subject.user.id}/release-address`,
        payload: { email: subject.user.email },
      });
    }

    function mail(subject: TestSession) {
      return peer.emailOutbox.enqueue({
        to_email: subject.user.email,
        recipient_user_id: subject.user.id,
        subject: 'Private old account notice',
        body_html: '<p>Old account private content</p>',
        body_text: 'Old account private content',
      });
    }

    for (const rollback of [false, true]) {
      it(`orders an insert after an empty cancellation scan, rollback=${rollback}`, async () => {
        const subject = await disabledAccount();
        const scanned = barrier();
        const resume = barrier();
        afterScan = async () => {
          scanned.resolve();
          await resume.promise;
          if (rollback) throw new Error('injected release rollback after mail cancellation');
        };
        const releasing = release(subject);
        let settled = false;
        let enqueue: ReturnType<typeof mail> | null = null;
        try {
          await Promise.race([
            scanned.promise,
            releasing.then((response) => {
              throw new Error(`release missed the cancellation barrier: ${response.body}`);
            }),
          ]);
          // A separate store/transaction starts after the scan found no row.
          // Without the recipient write this inserts and can be claimed while
          // the release still exposes the old committed email to readers.
          enqueue = mail(subject).then((result) => {
            settled = true;
            return result;
          });
          await new Promise((resolve) => setTimeout(resolve, 50));
          assert.equal(settled, false, 'enqueue cannot escape an open release transaction');
          resume.resolve();
          const released = await releasing;
          assert.equal(released.statusCode, rollback ? 500 : 200, released.body);
          const queued = await enqueue;
          assert.equal(queued.entry.status, rollback ? 'pending' : 'failed');
          if (!rollback) assert.equal(queued.entry.last_error, 'recipient-address-changed');
          other.mailbox.clear();
          await other.tick();
          assert.equal(other.mailbox.sent.length, rollback ? 1 : 0);
          if (!rollback) {
            const rightful = await h.registerUser({ email: subject.user.email });
            assert.notEqual(rightful.user.id, subject.user.id);
          }
        } finally {
          resume.resolve();
          await releasing;
          await enqueue;
        }
      });
    }

    it('orders a queued claim behind cancellation without reviving mail', async () => {
      const subject = await disabledAccount();
      await other.tick();
      const queued = await mail(subject);
      const scanned = barrier();
      const resume = barrier();
      afterScan = async () => {
        scanned.resolve();
        await resume.promise;
      };
      const releasing = release(subject);
      let claiming: ReturnType<NexusStore['emailOutbox']['claimDue']> | null = null;
      let settled = false;
      try {
        await Promise.race([
          scanned.promise,
          releasing.then((response) => {
            throw new Error(`release missed the cancellation barrier: ${response.body}`);
          }),
        ]);
        claiming = peer.emailOutbox.claimDue(isoInSeconds(60), 20).then((rows) => {
          settled = true;
          return rows;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(settled, false, 'claim cannot escape the open recipient release');
        resume.resolve();
        const released = await releasing;
        assert.equal(released.statusCode, 200, released.body);
        assert.deepEqual(await claiming, []);
        const row = await peer.emailOutbox.findById(queued.entry.id);
        assert.equal(row?.status, 'failed');
        assert.equal(row?.last_error, 'address-released');
      } finally {
        resume.resolve();
        await releasing;
        await claiming;
      }
    });

    it('keeps late old-account mail bound to the released account', async () => {
      const subject = await disabledAccount();
      const queued = await mail(subject);
      // A delayed old-account producer cannot make the replacement recipient eligible.
      assert.equal((await release(subject)).statusCode, 200);
      const rightful = await h.registerUser({ email: subject.user.email });
      const stale = await mail(subject);
      assert.equal(stale.entry.status, 'failed');
      assert.equal(stale.entry.recipient_user_id, subject.user.id);
      assert.notEqual(rightful.user.id, stale.entry.recipient_user_id);
      assert.equal((await peer.emailOutbox.findById(queued.entry.id))?.status, 'failed');
      assert.deepEqual(await peer.emailOutbox.claimDue(isoInSeconds(60), 20), []);
    });

    it('checks the recipient again at claim time, before making stale mail sending', async () => {
      const subject = await disabledAccount();
      const queued = await mail(subject);
      const changed = `${newId()}@example.test`;
      // Model a retained pending row, before cancellation existed. Claim must
      // independently fence it rather than rely on the enqueue's old check.
      await peer.users.update(subject.user.id, { email: changed });
      assert.deepEqual(await peer.emailOutbox.claimDue(isoInSeconds(60), 1), []);
      const row = await peer.emailOutbox.findById(queued.entry.id);
      assert.equal(row?.status, 'failed');
      assert.equal(row?.last_error, 'recipient-address-changed');
    });

    it('keeps release ordered with the actual handoff until the attempt settles', async () => {
      const subject = await disabledAccount();
      const queued = await mail(subject);
      const handingOff = barrier();
      const settle = barrier();
      const worker = createOutboxWorker({
        store: peer,
        crypto: h.app.nexus.crypto,
        batchSize: 1,
        transportFactory: async () => ({
          async send(): Promise<void> {
            handingOff.resolve();
            await settle.promise;
          },
        }),
      });
      const tick = worker.tick();
      let releasing: ReturnType<typeof release> | null = null;
      try {
        await Promise.race([
          handingOff.promise,
          tick.then(() => {
            throw new Error('handoff barrier missed');
          }),
        ]);
        let finished = false;
        releasing = release(subject).then((response) => {
          finished = true;
          return response;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(finished, false, 'release cannot overtake the live handoff');
        assert.equal((await peer.emailOutbox.findById(queued.entry.id))?.status, 'sending');
        settle.resolve();
        assert.equal((await tick).sent, 1);
        const released = await releasing;
        assert.equal(released.statusCode, 200, released.body);
      } finally {
        settle.resolve();
        await tick;
        await releasing;
        await worker.stop();
      }
    });

    it('never makes a disable wait for a stalled SMTP handoff', async () => {
      const subject = await h.registerUser({ email: `${newId()}@example.test` });
      await other.tick();
      const queued = await mail(subject);
      const handingOff = barrier();
      const settle = barrier();
      const worker = createOutboxWorker({
        store: peer,
        crypto: h.app.nexus.crypto,
        batchSize: 1,
        transportFactory: async () => ({
          async send(): Promise<void> {
            handingOff.resolve();
            await settle.promise;
          },
        }),
      });
      const tick = worker.tick();
      try {
        await Promise.race([
          handingOff.promise,
          tick.then(() => {
            throw new Error('handoff barrier missed');
          }),
        ]);
        // The relay is stalled mid-send. The emergency disable must not queue
        // behind it on the account's lifecycle lease.
        const disabled = await h.authed(founder, {
          method: 'PATCH',
          url: `/api/users/${subject.user.id}`,
          payload: { status: 'disabled' },
        });
        assert.equal(disabled.statusCode, 200, disabled.body);
        assert.equal((await peer.users.findById(subject.user.id))?.status, 'disabled');
        assert.equal((await peer.emailOutbox.findById(queued.entry.id))?.status, 'sending');
        settle.resolve();
        assert.equal((await tick).sent, 1);
        assert.equal((await peer.emailOutbox.findById(queued.entry.id))?.status, 'sent');
      } finally {
        settle.resolve();
        await tick;
        await worker.stop();
      }
    });

    if (label !== 'sqlite') {
      it('fences an enqueue whose transaction snapshot predates release', async () => {
        const subject = await disabledAccount();
        const read = barrier();
        const resume = barrier();
        let first = true;
        const enqueue = peer.transaction(async (tx) => {
          const snapshot = await tx.users.findById(subject.user.id);
          if (first) {
            first = false;
            assert.equal(snapshot?.email, subject.user.email);
            read.resolve();
            await resume.promise;
          }
          return tx.emailOutbox.enqueue({
            to_email: subject.user.email,
            recipient_user_id: subject.user.id,
            subject: 'Stale transaction notice',
            body_html: '<p>Private</p>',
            body_text: 'Private',
          });
        });
        try {
          await read.promise;
          assert.equal((await release(subject)).statusCode, 200);
          resume.resolve();
          const queued = await enqueue;
          assert.equal(queued.entry.status, 'failed');
          assert.equal(queued.entry.last_error, 'recipient-address-changed');
          other.mailbox.clear();
          await other.tick();
          assert.deepEqual(other.mailbox.sent, []);
        } finally {
          resume.resolve();
          await enqueue;
        }
      });
    }

    it('cancels real SMTP before release and still delivers fresh replacement mail', async () => {
      const subject = await disabledAccount();
      const queued = await mail(subject);
      const relay = await slowRelay();
      const worker = createOutboxWorker({
        store: peer,
        crypto: h.app.nexus.crypto,
        batchSize: 1,
        transportFactory: async () =>
          createSmtpTransport(
            {
              host: '127.0.0.1',
              port: relay.port,
              secure: false,
              user: null,
              password: null,
              from: 'portal@example.test',
            },
            { budgetMs: 250 },
          ),
      });
      const tick = worker.tick();
      try {
        await Promise.race([
          relay.connected,
          tick.then(() => {
            throw new Error('real SMTP attempt never started');
          }),
        ]);
        const released = await release(subject);
        assert.equal(released.statusCode, 200, released.body);
        await tick;
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        assert.deepEqual(relay.received, [], 'no underlying SMTP send survived release');
        assert.equal((await peer.emailOutbox.findById(queued.entry.id))?.status, 'failed');
        const rightful = await h.registerUser({ email: subject.user.email });
        relay.speedUp();
        const fresh = await mail(rightful);
        const delivered = await worker.tick();
        assert.equal(delivered.sent, 1);
        assert.equal((await peer.emailOutbox.findById(fresh.entry.id))?.status, 'sent');
        assert.equal(relay.received.length, 1, 'recovery did not disable future delivery');
      } finally {
        await worker.stop();
        await tick;
        await relay.close();
      }
    });
  });
}
