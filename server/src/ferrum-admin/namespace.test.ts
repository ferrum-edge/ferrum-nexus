import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isNexusError } from '../lib/errors.js';
import {
  assertNamespaceServed,
  createNamespaceMonitor,
  namespaceUnserved,
  namespaceUnservedMessage,
  parseNamespaceServing,
} from './namespace.js';

/** The block a `database`-mode gateway serving `ferrum` publishes. */
const SERVING_FERRUM = {
  active: 'ferrum',
  serving_scope: 'single-namespace-data-plane',
  data_plane_single_namespace: true,
};

describe('edge namespace routability', () => {
  describe('parseNamespaceServing', () => {
    it('reads the block a single-namespace data plane publishes', () => {
      assert.deepEqual(parseNamespaceServing(SERVING_FERRUM), {
        active: 'ferrum',
        servingScope: 'single-namespace-data-plane',
        dataPlaneSingleNamespace: true,
      });
    });

    it('reads a control plane as serving nothing in particular', () => {
      assert.deepEqual(
        parseNamespaceServing({
          active: null,
          serving_scope: 'control-plane',
          data_plane_single_namespace: false,
        }),
        { active: null, servingScope: 'control-plane', dataPlaneSingleNamespace: false },
      );
    });

    it('is null for a gateway that publishes no block at all', () => {
      for (const raw of [undefined, null, 'ferrum', 42, ['ferrum']]) {
        assert.equal(parseNamespaceServing(raw), null, String(raw));
      }
    });

    it('never invents a branch condition out of a malformed block', () => {
      assert.deepEqual(parseNamespaceServing({ active: 'ferrum' }), {
        active: 'ferrum',
        servingScope: null,
        dataPlaneSingleNamespace: false,
      });
      assert.deepEqual(parseNamespaceServing({ active: '', data_plane_single_namespace: 'true' }), {
        active: null,
        servingScope: null,
        dataPlaneSingleNamespace: false,
      });
    });
  });

  describe('namespaceUnserved', () => {
    const serving = parseNamespaceServing(SERVING_FERRUM);

    it('is true only when a single-namespace data plane names another namespace', () => {
      assert.equal(namespaceUnserved('nexusiso', serving), true);
      assert.equal(namespaceUnserved('ferrum', serving), false);
    });

    it('asserts nothing about a gateway that reports no block', () => {
      assert.equal(namespaceUnserved('nexusiso', null), false);
    });

    it('leaves a control plane alone — multi-namespace writes are its purpose', () => {
      const controlPlane = parseNamespaceServing({
        active: null,
        serving_scope: 'control-plane',
        data_plane_single_namespace: false,
      });
      assert.equal(namespaceUnserved('nexusiso', controlPlane), false);
    });
  });

  describe('the monitor', () => {
    it('starts with no verdict and reports one only once the gateway speaks', () => {
      const monitor = createNamespaceMonitor('nexusiso');
      assert.deepEqual(monitor.routing(), {
        configured: 'nexusiso',
        active: null,
        serving_scope: null,
        data_plane_single_namespace: null,
        unserved: false,
        unserved_mutation_observed: false,
        checked_at: null,
      });
      const at = Date.parse('2026-09-12T00:00:00Z');
      monitor.observeHealth(parseNamespaceServing(SERVING_FERRUM), at);
      assert.deepEqual(monitor.routing(), {
        configured: 'nexusiso',
        active: 'ferrum',
        serving_scope: 'single-namespace-data-plane',
        data_plane_single_namespace: true,
        unserved: true,
        unserved_mutation_observed: false,
        checked_at: '2026-09-12T00:00:00.000Z',
      });
    });

    it('keeps the last verdict when a gateway answers without a block', () => {
      const monitor = createNamespaceMonitor('nexusiso');
      monitor.observeHealth(parseNamespaceServing(SERVING_FERRUM));
      monitor.observeHealth(null);
      assert.equal(monitor.routing().unserved, true);
      assert.equal(monitor.routing().active, 'ferrum');
    });

    it('degrades on the response header alone, and logs the transition once', () => {
      const monitor = createNamespaceMonitor('nexusiso');
      assert.equal(monitor.observeUnservedMutation(), true, 'first observation');
      assert.equal(monitor.observeUnservedMutation(), false, 'already known');
      const routing = monitor.routing();
      assert.equal(routing.unserved, true);
      assert.equal(routing.unserved_mutation_observed, true);
      // The header says only "not this namespace", never which one is served.
      assert.equal(routing.active, null);
      assert.equal(routing.serving_scope, null);
    });

    it('recovers when the gateway later reports it does serve the namespace', () => {
      const monitor = createNamespaceMonitor('ferrum');
      monitor.observeUnservedMutation();
      assert.equal(monitor.routing().unserved, true);
      monitor.observeHealth(parseNamespaceServing(SERVING_FERRUM));
      assert.equal(monitor.routing().unserved, false);
      assert.equal(monitor.routing().unserved_mutation_observed, false);
    });

    it('does not let a blockless answer clear a header the gateway stamped', () => {
      const monitor = createNamespaceMonitor('nexusiso');
      monitor.observeUnservedMutation();
      monitor.observeHealth(null);
      assert.equal(monitor.routing().unserved, true);
    });
  });

  describe('the refusal', () => {
    it('passes a routable namespace through', () => {
      const monitor = createNamespaceMonitor('ferrum');
      monitor.observeHealth(parseNamespaceServing(SERVING_FERRUM));
      assert.doesNotThrow(() => {
        assertNamespaceServed(monitor.routing());
      });
    });

    it('names both namespaces, both fixes, and the setting', () => {
      const monitor = createNamespaceMonitor('nexusiso');
      monitor.observeHealth(parseNamespaceServing(SERVING_FERRUM));
      const routing = monitor.routing();
      assert.match(namespaceUnservedMessage(routing), /'nexusiso'/);
      assert.match(namespaceUnservedMessage(routing), /FERRUM_NAMESPACE=ferrum on the portal/);
      assert.match(namespaceUnservedMessage(routing), /gateway with FERRUM_NAMESPACE=nexusiso/);
      let error: unknown;
      try {
        assertNamespaceServed(routing);
      } catch (caught) {
        error = caught;
      }
      assert.ok(isNexusError(error));
      assert.equal(error.code, 'EDGE_NAMESPACE_UNSERVED');
      assert.equal(error.statusCode, 409);
      assert.deepEqual(error.details, {
        configured_namespace: 'nexusiso',
        active_namespace: 'ferrum',
        serving_scope: 'single-namespace-data-plane',
        setting: 'FERRUM_NAMESPACE',
      });
    });

    it('points at GET /health when only the header revealed the mismatch', () => {
      const monitor = createNamespaceMonitor('nexusiso');
      monitor.observeUnservedMutation();
      const message = namespaceUnservedMessage(monitor.routing());
      assert.match(message, /namespace\.active/);
      assert.doesNotMatch(message, /FERRUM_NAMESPACE=null/);
    });
  });
});
