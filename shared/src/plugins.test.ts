import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CORRELATION_ID_RESERVED_HEADERS, isGatewayOwnedConsumerHeader } from './plugins.js';

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

  it('leaves names outside the namespace alone', () => {
    for (const name of ['x-consumer', 'consumer-id', 'x-custom-consumer-id', 'x-request-id']) {
      assert.equal(isGatewayOwnedConsumerHeader(name), false);
    }
  });
});
