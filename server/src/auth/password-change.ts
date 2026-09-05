import type { NexusStore } from '../db/store.js';
import { createKeyedSerializer, type KeyedSerializer } from '../lib/keyed-serializer.js';

/**
 * Order password changes across services and instances. Take the lease before
 * opening a transaction, and keep it until any replacement session is issued.
 */
export function createPasswordChangeSerializer(store: NexusStore): KeyedSerializer {
  const serialize = createKeyedSerializer({
    leases: store.leases,
    conflictMessage: 'Another password change is in flight — please retry',
  });
  return (userId, fn) => serialize(`users:password:${userId}`, fn);
}
