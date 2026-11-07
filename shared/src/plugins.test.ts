import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CORRELATION_ID_RESERVED_HEADERS,
  PLUGIN_ADMISSION_RULES,
  isGatewayOwnedConsumerHeader,
  isProxyHopsHeader,
  pluginAdmissionProblem,
} from './plugins.js';

/**
 * Edge's closed `RESERVED_HEADER_NAMES` set at `v0.9.9`, copied verbatim from
 * `src/plugins/correlation_id.rs:18-63` (lowercased, in Edge's order). Nexus
 * has no vendored contract for header names, so this literal is the pin: a
 * change on either side must be reconciled here, not silently drift.
 */
const EDGE_V099_RESERVED_HEADER_NAMES: readonly string[] = [
  'api-key',
  'authentication-info',
  'authorization',
  'connection',
  'content-encoding',
  'content-length',
  'cookie',
  'early-data',
  'expect',
  'forwarded',
  'grpc-message',
  'grpc-status',
  'grpc-status-details-bin',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authentication-info',
  'proxy-authorization',
  'proxy-connection',
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
  'set-cookie',
  'te',
  'traceparent',
  'tracestate',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'www-authenticate',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-ferrum-original-content-encoding',
  'x-forwarded-authorization',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-goog-api-key',
  'x-grpc-web-mode',
  'x-xsrf-token',
];

describe('CORRELATION_ID_RESERVED_HEADERS', () => {
  it('matches the reserved set Ferrum Edge v0.9.9 refuses, exactly', () => {
    assert.deepEqual([...CORRELATION_ID_RESERVED_HEADERS], [...EDGE_V099_RESERVED_HEADER_NAMES]);
  });

  it('holds every header lowercase so lookups can lowercase the input once', () => {
    for (const name of CORRELATION_ID_RESERVED_HEADERS) {
      assert.equal(name, name.toLowerCase());
    }
  });
});

describe('isGatewayOwnedConsumerHeader', () => {
  it('matches the whole x-consumer-* namespace, case- and separator-insensitively', () => {
    for (const name of ['x-consumer-id', 'X-Consumer-Trace', 'x_consumer-a', ' X-consumer-  ']) {
      assert.equal(isGatewayOwnedConsumerHeader(name), true);
    }
  });

  it('matches X-Authenticated-Identity exactly, case- and separator-insensitively', () => {
    // Edge v0.9.15 adds the external identity header to the same gateway-owned check.
    for (const name of [
      'X-Authenticated-Identity',
      'x_authenticated_identity',
      'x-Authenticated_identity',
      ' x-authenticated-identity ',
    ]) {
      assert.equal(isGatewayOwnedConsumerHeader(name), true, name);
    }
    for (const name of ['x-authenticated-identity-id', 'x-authenticated', 'x-identity']) {
      assert.equal(isGatewayOwnedConsumerHeader(name), false, name);
    }
  });

  it('leaves names outside the namespace alone', () => {
    for (const name of ['x-consumer', 'consumer-id', 'x-custom-consumer-id', 'x-request-id']) {
      assert.equal(isGatewayOwnedConsumerHeader(name), false);
    }
  });
});

describe('isProxyHopsHeader', () => {
  it('matches X-Ferrum-Hops exactly, case- and separator-insensitively', () => {
    // Edge v0.9.17 reserves its loop-guard hop count as a header destination.
    for (const name of ['X-Ferrum-Hops', 'x_ferrum_hops', 'x-Ferrum_hops', ' x-ferrum-hops ']) {
      assert.equal(isProxyHopsHeader(name), true, name);
    }
    for (const name of ['x-ferrum-hops-count', 'x-ferrum', 'x-hops', 'x-consumer-id']) {
      assert.equal(isProxyHopsHeader(name), false, name);
    }
  });
});

describe('pluginAdmissionProblem', () => {
  it('has rules for exactly the four plugins Edge refuses beyond their key sets', () => {
    assert.deepEqual(Object.keys(PLUGIN_ADMISSION_RULES).sort(), [
      'bot_detection',
      'correlation_id',
      'ip_restriction',
      'request_deduplication',
    ]);
    assert.equal(pluginAdmissionProblem('cors', { header_name: 'Authorization' }), null);
    assert.equal(pluginAdmissionProblem('__proto__', {}), null);
  });

  it('ip_restriction: refuses a config whose allow and deny lists are both empty', () => {
    for (const config of [{}, { allow: [], deny: [] }, { allow: [] }]) {
      const problem = pluginAdmissionProblem('ip_restriction', config);
      assert.ok(problem, JSON.stringify(config));
      assert.equal(problem.field, undefined, 'a whole-plugin rule');
      assert.match(problem.message, /restrict nobody/);
    }
    assert.equal(pluginAdmissionProblem('ip_restriction', { allow: ['10.0.0.0/8'] }), null);
    assert.equal(pluginAdmissionProblem('ip_restriction', { deny: ['10.0.0.1'] }), null);
  });

  it('bot_detection: an explicit empty blocked list needs missing-UA requests rejected', () => {
    const problem = pluginAdmissionProblem('bot_detection', { blocked_patterns: [] });
    assert.ok(problem);
    assert.equal(problem.field, undefined, 'a whole-plugin rule');
    assert.match(problem.message, /blocks nothing/);
    assert.ok(
      pluginAdmissionProblem('bot_detection', {
        blocked_patterns: [],
        allow_missing_user_agent: true,
      }),
    );
    assert.equal(
      pluginAdmissionProblem('bot_detection', {
        blocked_patterns: [],
        allow_missing_user_agent: false,
      }),
      null,
    );
    assert.equal(pluginAdmissionProblem('bot_detection', { blocked_patterns: ['curl'] }), null);
  });

  it('bot_detection: an absent blocked list is Edge’s default list, not an empty one', () => {
    // The server judges the wire body, where an omitted key means Edge's
    // default. The plugin form deliberately passes an emptied box as `[]`.
    assert.equal(pluginAdmissionProblem('bot_detection', {}), null);
    assert.equal(pluginAdmissionProblem('bot_detection', { allow_list: ['GoogleBot'] }), null);
  });

  it('correlation_id: refuses reserved, consumer and hop-count headers on header_name', () => {
    for (const [header, pattern] of [
      ['  AUTHORIZATION ', /gateway owns 'AUTHORIZATION'/],
      ['x-forwarded-for', /gateway owns 'x-forwarded-for'/],
      ['X-Consumer-Trace', /x-consumer-\*/],
      ['x_authenticated-identity', /X-Authenticated-Identity/],
      ['x_ferrum-hops', /X-Ferrum-Hops/],
    ] as const) {
      const problem = pluginAdmissionProblem('correlation_id', { header_name: header });
      assert.ok(problem, header);
      assert.equal(problem.field, 'header_name');
      assert.match(problem.message, pattern);
    }
    for (const config of [
      {},
      { header_name: '' },
      { header_name: '  ' },
      { header_name: 'x-request-id' },
    ]) {
      assert.equal(pluginAdmissionProblem('correlation_id', config), null, JSON.stringify(config));
    }
  });

  it('request_deduplication: refuses only gateway-owned consumer headers', () => {
    for (const header of ['X-Consumer-Idempotency-Key', 'x_authenticated-identity']) {
      const problem = pluginAdmissionProblem('request_deduplication', { header_name: header });
      assert.ok(problem, header);
      assert.equal(problem.field, 'header_name');
      assert.match(problem.message, /idempotency key/);
    }
    // Edge reserves X-Ferrum-Hops as a correlation destination only, and does
    // not own a correlation-reserved name as a client-supplied key.
    for (const header of ['X-Ferrum-Hops', 'Authorization', 'Idempotency-Key', '']) {
      assert.equal(
        pluginAdmissionProblem('request_deduplication', { header_name: header }),
        null,
        header,
      );
    }
  });
});
