/**
 * Another writer between every step: a property test of credential retirement
 * and rotation recovery (issue #737).
 *
 * Nexus does not own a consumer's credential array. An operator, Foundry or
 * automation can append, remove, reorder or replace entries at any moment,
 * outside the portal's consumer lease. Earlier designs identified an entry by
 * its position and settled rows on array lengths, and review kept finding the
 * same class of bug: a same-length replacement (`[A, B]` → `[B, X]`), a
 * survivor that moved, or a take-back at a stale index made Nexus delete a key
 * it never meant to, or left a row claiming a key the gateway did not hold.
 *
 * This suite plays that other writer. It wraps the Admin client's consumer
 * calls and, before chosen calls of a revoke, a rotation (append-first and at
 * the cap), its retry and any take-back, changes the consumer's `keyauth`
 * array directly in the mock gateway. It does so for every step, every kind of
 * change, both gateway kinds (Edge with ferrum-edge#7393 and Edge v0.9.20),
 * and for a run of seeded changes before *every* step. Throughout, it asserts:
 *
 * - every entry a Nexus delete removes is the target, or a replacement Nexus
 *   itself appended during the operation (a take-back) — never another
 *   writer's key, never another of the portal's keys;
 * - Nexus never empties the `keyauth` type;
 * - no row is `revoked` while its entry is on the gateway;
 * - once a quiet attempt has run, every row matches the gateway: live exactly
 *   when its entry is there, and every entry Nexus appended has a live row.
 *
 * Keys are compared as stored on the mock gateway and never printed.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import type {
  CreateApplicationResponse,
  IssueCredentialResponse,
  RotateCredentialResponse,
} from '@ferrum-nexus/shared';

import { sha256Hex } from '../lib/crypto.js';
import { buildTestApp, TEST_EDGE_JWT_SECRET, type TestApp, type TestSession } from './helpers.js';
import { createMockFerrumEdge, type MockFerrumEdge } from './mock-ferrum-edge.js';

/** What the other writer does to the array, before one of Nexus's calls. */
const CHANGES = [
  'append',
  'prepend',
  'remove-foreign',
  'reorder',
  'replace-sibling',
  'replace-target',
  'remove-target',
] as const;
type Change = (typeof CHANGES)[number];

/** The operation under test, and the array it starts from. */
const OPERATIONS = ['revoke', 'rotate-append-first', 'rotate-at-cap'] as const;
type Operation = (typeof OPERATIONS)[number];

const MODES = ['evaluate', 'unsupported'] as const;

/** The portal's cap: two keys and one foreign entry fill it. */
const PORTAL_CAP = 3;
/** Steps explored per attempt; every operation here makes fewer calls. */
const MAX_STEPS = 9;
const CHAOS_SEEDS = 6;

/** One scenario's view of the gateway and of what Nexus did to it. */
interface Scenario {
  consumerId: string;
  /** The key the operation is about. */
  target: string;
  /** The portal's other key on the consumer. */
  sibling: string;
  /** Every key the other writer put on the consumer. */
  foreign: Set<string>;
  /** Keys a Nexus delete removed. */
  removed: string[];
  /** Whole-type deletes of `keyauth` Nexus sent. */
  wholeTypeDeletes: number;
  /** Which change to make before the call with this step number, if any. */
  plan: (step: number) => Change | null;
  step: number;
  /** Changes actually made. */
  made: number;
  nextForeign: number;
}

/** A small seeded generator, so a failing chaos run can be replayed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

describe('credential recovery under another writer at every step', () => {
  let edge: MockFerrumEdge;
  let harness: TestApp;
  let owner: TestSession;
  let active: Scenario | null = null;
  let restore: (() => void) | null = null;

  before(async () => {
    // Edge's own cap is far above the portal's, so the other writer's entries
    // never make Edge refuse an append and every path stays reachable.
    edge = createMockFerrumEdge({
      jwtSecret: TEST_EDGE_JWT_SECRET,
      issuer: 'ferrum-edge',
      maxCredentialsPerType: 64,
    });
    await edge.start();
    harness = await buildTestApp({
      edge,
      env: {
        FERRUM_MAX_CREDENTIALS_PER_TYPE: String(PORTAL_CAP),
        NEXUS_MAX_APPLICATIONS_PER_OWNER: '0',
      },
    });
    await harness.registerUser({ email: 'interleaving-founder@example.test' });
    owner = await harness.registerUser({
      email: 'interleaving-owner@example.test',
      role: 'client',
    });
    restore = installOtherWriter();
  });

  afterEach(() => {
    active = null;
    harness.edge.setCredentialIfMatch('evaluate');
    harness.edge.clearInjections();
  });

  after(async () => {
    restore?.();
    await harness.close();
    await edge.stop();
  });

  /* ── The gateway, as stored ─────────────────────────────────────────── */

  function storedKey(consumerId: string): string {
    return `nexus/${consumerId}`;
  }

  function keysOn(consumerId: string): string[] {
    const stored = harness.edge.consumers.get(storedKey(consumerId));
    return (stored?.credentials.keyauth ?? []).map((entry) => String(entry.key));
  }

  function setKeys(consumerId: string, keys: string[]): void {
    const stored = harness.edge.consumers.get(storedKey(consumerId));
    assert.ok(stored);
    if (keys.length === 0) delete stored.credentials.keyauth;
    else stored.credentials.keyauth = keys.map((key) => ({ key }));
    stored.updated_at = new Date(Date.now() + 60_000).toISOString();
  }

  /** Make one change to the scenario's array, as another writer would. */
  function change(scenario: Scenario, kind: Change): void {
    const keys = keysOn(scenario.consumerId);
    const fresh = (): string => {
      scenario.nextForeign += 1;
      const key = `foreign-${scenario.consumerId}-${scenario.nextForeign}`;
      scenario.foreign.add(key);
      return key;
    };
    let next: string[];
    switch (kind) {
      case 'append':
        next = [...keys, fresh()];
        break;
      case 'prepend':
        next = [fresh(), ...keys];
        break;
      case 'remove-foreign': {
        const victim = keys.find((key) => scenario.foreign.has(key));
        next = victim ? keys.filter((key) => key !== victim) : [...keys, fresh()];
        break;
      }
      case 'reorder':
        next = keys.length > 1 ? [...keys].reverse() : [...keys, fresh()];
        break;
      case 'replace-sibling':
        // `[A, B]` → `[B, X]` while the operation is about B.
        next = keys.includes(scenario.sibling)
          ? [...keys.filter((key) => key !== scenario.sibling), fresh()]
          : [...keys, fresh()];
        break;
      case 'replace-target':
        // `[A, B]` → `[B, X]` while the operation is about A.
        next = keys.includes(scenario.target)
          ? [...keys.filter((key) => key !== scenario.target), fresh()]
          : [...keys, fresh()];
        break;
      case 'remove-target':
        next = keys.includes(scenario.target)
          ? keys.filter((key) => key !== scenario.target)
          : [...keys, fresh()];
        break;
    }
    setKeys(scenario.consumerId, next);
    scenario.made += 1;
  }

  /**
   * Wrap the Admin client's consumer calls: before each call about the active
   * scenario's consumer, make the change its plan names; around each delete,
   * record which keys it removed.
   */
  function installOtherWriter(): () => void {
    const consumers = harness.edgeClient.consumers;
    const real = {
      get: consumers.get.bind(consumers),
      getTagged: consumers.getTagged.bind(consumers),
      verification: consumers.verification.bind(consumers),
      addCredential: consumers.addCredential.bind(consumers),
      deleteCredentialAt: consumers.deleteCredentialAt.bind(consumers),
      deleteCredentialType: consumers.deleteCredentialType.bind(consumers),
    };
    const step = (id: string): Scenario | null => {
      const scenario = active;
      if (!scenario || id !== scenario.consumerId) return null;
      const kind = scenario.plan(scenario.step);
      scenario.step += 1;
      if (kind) change(scenario, kind);
      return scenario;
    };
    const observed = async <T>(scenario: Scenario | null, call: () => Promise<T>): Promise<T> => {
      if (!scenario) return call();
      const before = keysOn(scenario.consumerId);
      try {
        return await call();
      } finally {
        const left = new Set(keysOn(scenario.consumerId));
        for (const key of before) if (!left.has(key)) scenario.removed.push(key);
      }
    };
    consumers.get = async (id, options) => {
      step(id);
      return real.get(id, options);
    };
    consumers.getTagged = async (id, options) => {
      step(id);
      return real.getTagged(id, options);
    };
    consumers.verification = async (id, subject) => {
      step(id);
      return real.verification(id, subject);
    };
    consumers.addCredential = async (id, type, entry, subject, ifMatch) => {
      step(id);
      return real.addCredential(id, type, entry, subject, ifMatch);
    };
    consumers.deleteCredentialAt = async (id, type, index, subject, ifMatch) => {
      const scenario = step(id);
      return observed(scenario, () => real.deleteCredentialAt(id, type, index, subject, ifMatch));
    };
    consumers.deleteCredentialType = async (id, type, subject, ifMatch) => {
      const scenario = step(id);
      if (scenario && type === 'keyauth') scenario.wholeTypeDeletes += 1;
      return observed(scenario, () => real.deleteCredentialType(id, type, subject, ifMatch));
    };
    return () => {
      Object.assign(consumers, real);
    };
  }

  /* ── The portal ─────────────────────────────────────────────────────── */

  async function application(): Promise<string> {
    const response = await harness.authed(owner, {
      method: 'POST',
      url: '/api/applications',
      payload: { name: `interleaving ${Math.random().toString(36).slice(2)}` },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<CreateApplicationResponse>().application.id;
  }

  function issue(applicationId: string) {
    return harness.authed(owner, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth', application_id: applicationId },
    });
  }

  function attempt(operation: Operation, credentialId: string) {
    if (operation === 'revoke') {
      return harness.authed(owner, { method: 'DELETE', url: `/api/credentials/${credentialId}` });
    }
    return harness.authed(owner, {
      method: 'POST',
      url: `/api/credentials/${credentialId}/rotate`,
      payload: {},
    });
  }

  async function rowsOf(consumerId: string) {
    return harness.store.credentials.listByConsumer(consumerId, 'keyauth');
  }

  /**
   * Set up a consumer with the portal's two keys (plus a foreign entry where
   * the operation starts at the cap or is a revoke) and pick the target.
   */
  async function arrange(
    operation: Operation,
    targetFirst: boolean,
  ): Promise<{ scenario: Scenario; targetId: string; initial: Set<string> }> {
    const applicationId = await application();
    const first = await issue(applicationId);
    assert.equal(first.statusCode, 201, first.body);
    const second = await issue(applicationId);
    assert.equal(second.statusCode, 201, second.body);
    const a = first.json<IssueCredentialResponse>();
    const b = second.json<IssueCredentialResponse>();
    const consumerId = a.credential.ferrum_consumer_id;
    const [target, sibling] = targetFirst ? [a, b] : [b, a];
    const scenario: Scenario = {
      consumerId,
      target: String(target.secret.key),
      sibling: String(sibling.secret.key),
      foreign: new Set(),
      removed: [],
      wholeTypeDeletes: 0,
      plan: () => null,
      step: 0,
      made: 0,
      nextForeign: 0,
    };
    if (operation !== 'rotate-append-first') {
      // Below the portal's cap of three, the rotation appends first; with a
      // foreign entry in front it is at the cap and deletes first.
      scenario.nextForeign += 1;
      const foreign = `foreign-${consumerId}-0`;
      scenario.foreign.add(foreign);
      setKeys(consumerId, [foreign, ...keysOn(consumerId)]);
    }
    return {
      scenario,
      targetId: target.credential.id,
      initial: new Set([scenario.target, scenario.sibling]),
    };
  }

  /** Every key a Nexus delete removed was the target or one Nexus appended. */
  function assertOnlyItsOwnDeleted(scenario: Scenario, initial: Set<string>, label: string): void {
    assert.equal(scenario.wholeTypeDeletes, 0, `${label}: Nexus emptied the keyauth type`);
    for (const key of scenario.removed) {
      const allowed = key === scenario.target || (!initial.has(key) && !scenario.foreign.has(key));
      assert.ok(
        allowed,
        `${label}: a Nexus delete removed ${
          scenario.foreign.has(key) ? 'another writer’s key' : 'another of the portal’s keys'
        }`,
      );
    }
  }

  /** No row is `revoked` while its entry is on the gateway. */
  async function assertNoRevokedLiveKey(scenario: Scenario, label: string): Promise<void> {
    const onGateway = new Set(keysOn(scenario.consumerId).map(sha256Hex));
    for (const row of await rowsOf(scenario.consumerId)) {
      if (row.status !== 'revoked') continue;
      assert.ok(!onGateway.has(row.fingerprint), `${label}: a revoked row's key still works`);
    }
  }

  /** Every row matches the gateway, and every key Nexus appended has a live row. */
  async function assertRowsMatchGateway(scenario: Scenario, label: string): Promise<void> {
    const keys = keysOn(scenario.consumerId);
    const onGateway = new Set(keys.map(sha256Hex));
    const rows = await rowsOf(scenario.consumerId);
    for (const row of rows) {
      const live = row.status === 'active' || row.status === 'retiring';
      assert.equal(
        live,
        onGateway.has(row.fingerprint),
        `${label}: a ${row.status} row ${live ? 'claims a key the gateway lacks' : 'hides a live key'}`,
      );
    }
    const liveFingerprints = new Set(
      rows.filter((row) => row.status !== 'revoked').map((row) => row.fingerprint),
    );
    for (const key of keys) {
      if (scenario.foreign.has(key)) continue;
      assert.ok(liveFingerprints.has(sha256Hex(key)), `${label}: a portal key has no live row`);
    }
  }

  async function targetLive(targetId: string): Promise<boolean> {
    const row = await harness.store.credentials.findById(targetId);
    return row?.status === 'active' || row?.status === 'retiring';
  }

  /**
   * Run one scenario: the operation under `first`, a retry under `retry` when
   * it did not finish, then a quiet retry and a quiet issue (whose read
   * settles every row by its material), checking the invariants after each.
   * Answers whether `first` made any change at all.
   */
  async function run(
    mode: (typeof MODES)[number],
    operation: Operation,
    targetFirst: boolean,
    first: (step: number) => Change | null,
    retry: (step: number) => Change | null,
    label: string,
  ): Promise<boolean> {
    harness.edge.setCredentialIfMatch(mode);
    const { scenario, targetId, initial } = await arrange(operation, targetFirst);
    active = scenario;
    const replacements: string[] = [];
    const record = (response: { statusCode: number; json: <T>() => T }): void => {
      if (operation !== 'revoke' && response.statusCode === 200) {
        replacements.push(String(response.json<RotateCredentialResponse>().secret.key));
      }
    };
    try {
      scenario.plan = first;
      scenario.step = 0;
      const answer = await attempt(operation, targetId);
      assert.ok(answer.statusCode < 500 || answer.statusCode === 502, `${label}: ${answer.body}`);
      record(answer);
      const changed = scenario.made > 0;
      assertOnlyItsOwnDeleted(scenario, initial, `${label}, first attempt`);
      await assertNoRevokedLiveKey(scenario, `${label}, first attempt`);

      if (await targetLive(targetId)) {
        scenario.plan = retry;
        scenario.step = 0;
        const again = await attempt(operation, targetId);
        record(again);
        assertOnlyItsOwnDeleted(scenario, initial, `${label}, retry`);
        await assertNoRevokedLiveKey(scenario, `${label}, retry`);
      }

      scenario.plan = () => null;
      if (await targetLive(targetId)) {
        // Nothing else is moving the array now, so the operation finishes:
        // a revoke always; a rotation unless its key proves to be gone.
        const quiet = await attempt(operation, targetId);
        record(quiet);
        if (operation === 'revoke') {
          assert.equal(quiet.statusCode, 200, `${label}, quiet retry: ${quiet.body}`);
        } else {
          assert.ok(
            quiet.statusCode === 200 || quiet.statusCode === 409,
            `${label}, quiet retry: ${quiet.body}`,
          );
        }
        assertOnlyItsOwnDeleted(scenario, initial, `${label}, quiet retry`);
      }
      assert.equal(await targetLive(targetId), false, `${label}: the target outlived the retries`);

      // A quiet issue reads the consumer credential-complete and settles every
      // row by its material before its cap check, whether or not it appends.
      const settle = await issue(
        (await harness.store.credentials.findById(targetId))?.application_id ?? '',
      );
      assert.ok(settle.statusCode === 201 || settle.statusCode === 409, settle.body);
      assertOnlyItsOwnDeleted(scenario, initial, `${label}, settle`);
      await assertRowsMatchGateway(scenario, label);
      assert.ok(!keysOn(scenario.consumerId).includes(scenario.target), `${label}: target live`);
      for (const key of replacements) {
        assert.ok(keysOn(scenario.consumerId).includes(key), `${label}: replacement missing`);
      }
      return changed;
    } finally {
      active = null;
    }
  }

  for (const mode of MODES) {
    const gateway = mode === 'evaluate' ? 'Edge with #7393' : 'Edge v0.9.20';
    for (const operation of OPERATIONS) {
      for (const kind of CHANGES) {
        it(`${gateway}, ${operation}: ${kind} before any one step`, async () => {
          for (let at = 0; at < MAX_STEPS; at += 1) {
            const once = (step: number): Change | null => (step === at ? kind : null);
            const changed = await run(
              mode,
              operation,
              at % 2 === 0,
              once,
              once,
              `${operation}, ${kind} before step ${at}`,
            );
            if (!changed) break;
          }
        });

        it(`${gateway}, ${operation}: ${kind} before every step from one on`, async () => {
          for (let from = 0; from < MAX_STEPS; from += 1) {
            const onward = (step: number): Change | null => (step >= from ? kind : null);
            const changed = await run(
              mode,
              operation,
              from % 2 === 1,
              onward,
              (step) => (step === from ? kind : null),
              `${operation}, ${kind} before every step from ${from}`,
            );
            if (!changed) break;
          }
        });
      }

      it(`${gateway}, ${operation}: seeded changes before every step`, async () => {
        for (let seed = 1; seed <= CHAOS_SEEDS; seed += 1) {
          const random = seeded(seed * 7919 + OPERATIONS.indexOf(operation));
          const pick = (): Change => CHANGES[Math.floor(random() * CHANGES.length)] ?? 'append';
          await run(
            mode,
            operation,
            seed % 2 === 0,
            () => pick(),
            () => pick(),
            `${operation}, seed ${seed}`,
          );
        }
      });
    }
  }
});
