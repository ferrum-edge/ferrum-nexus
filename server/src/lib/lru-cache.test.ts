import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LruCache } from './lru-cache.js';

describe('LruCache', () => {
  it('counts misses and hits, and returns what was stored', () => {
    const cache = new LruCache<string | null>({ maxEntries: 4, maxBytes: 100 });
    assert.equal(cache.get('a'), undefined);
    cache.set('a', 'alpha', 5);
    cache.set('b', null, 1);
    assert.equal(cache.get('a'), 'alpha');
    assert.equal(cache.get('b'), null, 'a stored null is a hit, not a miss');
    assert.deepEqual(cache.stats(), { hits: 2, misses: 1, entries: 2, bytes: 6 });
  });

  it('evicts the least recently used entry past the entry bound', () => {
    const cache = new LruCache<number>({ maxEntries: 2, maxBytes: 100 });
    cache.set('a', 1, 1);
    cache.set('b', 2, 1);
    // Reading `a` makes `b` the least recently used.
    assert.equal(cache.get('a'), 1);
    cache.set('c', 3, 1);
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.get('c'), 3);
    assert.equal(cache.stats().entries, 2);
  });

  it('evicts until the byte bound holds', () => {
    const cache = new LruCache<string>({ maxEntries: 10, maxBytes: 10 });
    cache.set('a', 'a', 4);
    cache.set('b', 'b', 4);
    cache.set('c', 'c', 4);
    assert.equal(cache.get('a'), undefined, 'the oldest entry went to make room');
    assert.equal(cache.get('b'), 'b');
    assert.equal(cache.get('c'), 'c');
    assert.equal(cache.stats().bytes, 8);
  });

  it('never admits a value larger than the whole budget', () => {
    const cache = new LruCache<string>({ maxEntries: 10, maxBytes: 10 });
    cache.set('small', 'small', 5);
    cache.set('huge', 'huge', 11);
    assert.equal(cache.get('huge'), undefined);
    assert.equal(cache.get('small'), 'small', 'an oversized value evicts nothing');
    assert.equal(cache.stats().bytes, 5);
  });

  it('replaces an entry in place without double-counting its size', () => {
    const cache = new LruCache<string>({ maxEntries: 10, maxBytes: 10 });
    cache.set('a', 'first', 6);
    cache.set('a', 'second', 7);
    assert.equal(cache.get('a'), 'second');
    assert.deepEqual(cache.stats(), { hits: 1, misses: 0, entries: 1, bytes: 7 });
  });

  it('caches nothing when either bound is zero', () => {
    for (const options of [
      { maxEntries: 0, maxBytes: 100 },
      { maxEntries: 10, maxBytes: 0 },
    ]) {
      const cache = new LruCache<string>(options);
      cache.set('a', 'a', 1);
      assert.equal(cache.get('a'), undefined);
      assert.equal(cache.stats().entries, 0);
    }
  });

  it('drops every entry on clear', () => {
    const cache = new LruCache<string>({ maxEntries: 10, maxBytes: 10 });
    cache.set('a', 'a', 3);
    cache.clear();
    assert.equal(cache.get('a'), undefined);
    assert.deepEqual(cache.stats(), { hits: 0, misses: 1, entries: 0, bytes: 0 });
  });
});
