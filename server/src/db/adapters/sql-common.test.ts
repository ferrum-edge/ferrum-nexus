/**
 * Unit tests for the dialect shims.
 *
 * Everything here is pure — no database is involved. The behavioural coverage
 * of the adapters themselves lives in `src/test/smoke.test.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@ferrum-nexus/shared';

import { isNexusError } from '../../lib/errors.js';
import {
  bool,
  encodeBool,
  encodeJson,
  formatSql,
  insertParts,
  int,
  json,
  mapSqlConflict,
  page,
  setParts,
  SqlWhereBuilder,
  text,
  textOrNull,
  upsertSql,
} from './sql-common.js';

describe('formatSql', () => {
  it('numbers placeholders left to right for postgres', () => {
    assert.equal(
      formatSql('SELECT * FROM users WHERE role = ? AND status = ? LIMIT ? OFFSET ?', 'pg'),
      'SELECT * FROM users WHERE role = $1 AND status = $2 LIMIT $3 OFFSET $4',
    );
  });

  it('leaves placeholders alone for mysql', () => {
    assert.equal(
      formatSql('SELECT * FROM users WHERE role = ? AND status = ?', 'mysql'),
      'SELECT * FROM users WHERE role = ? AND status = ?',
    );
  });

  it('rewrites double-quoted identifiers to backticks for mysql only', () => {
    assert.equal(
      formatSql('SELECT * FROM app_settings WHERE "key" = ?', 'mysql'),
      'SELECT * FROM app_settings WHERE `key` = ?',
    );
    assert.equal(
      formatSql('SELECT * FROM app_settings WHERE "key" = ?', 'pg'),
      'SELECT * FROM app_settings WHERE "key" = $1',
    );
  });

  it('never touches anything inside a string literal', () => {
    const sql = 'SELECT * FROM t WHERE a = ? AND b = \'is it ? or "quoted"\' AND c = ?';
    assert.equal(
      formatSql(sql, 'pg'),
      'SELECT * FROM t WHERE a = $1 AND b = \'is it ? or "quoted"\' AND c = $2',
    );
    assert.equal(formatSql(sql, 'mysql'), sql, 'mysql needs no rewriting here');
  });

  it("handles doubled '' escapes inside literals", () => {
    const sql = "SELECT * FROM t WHERE a = 'it''s ? fine' AND b = ?";
    assert.equal(formatSql(sql, 'pg'), "SELECT * FROM t WHERE a = 'it''s ? fine' AND b = $1");
  });

  it('is a no-op on SQL with neither placeholders nor quoted identifiers', () => {
    assert.equal(formatSql('SELECT 1', 'pg'), 'SELECT 1');
    assert.equal(formatSql('SELECT 1', 'mysql'), 'SELECT 1');
  });
});

describe('SqlWhereBuilder', () => {
  it('produces an empty clause when nothing was added', () => {
    assert.deepEqual(new SqlWhereBuilder().build(), { sql: '', params: [] });
  });

  it('skips conditions whose filter value is undefined', () => {
    const where = new SqlWhereBuilder()
      .add(undefined, 'role = ?', null)
      .add('admin', 'role = ?', 'admin')
      .build();
    assert.equal(where.sql, ' WHERE role = ?');
    assert.deepEqual(where.params, ['admin']);
  });

  it('AND-joins conditions in the order they were added', () => {
    const where = new SqlWhereBuilder()
      .always('a = ?', 1)
      .always('b IS NULL')
      .always('c = ?', 'x')
      .build();
    assert.equal(where.sql, ' WHERE a = ? AND b IS NULL AND c = ?');
    assert.deepEqual(where.params, [1, 'x']);
  });

  it('expands IN lists, and makes an empty list match nothing', () => {
    const populated = new SqlWhereBuilder().addIn('id', ['a', 'b', 'c']).build();
    assert.equal(populated.sql, ' WHERE id IN (?, ?, ?)');
    assert.deepEqual(populated.params, ['a', 'b', 'c']);

    const empty = new SqlWhereBuilder().addIn('id', []).build();
    assert.equal(empty.sql, ' WHERE 1 = 0');
    assert.deepEqual(empty.params, []);

    assert.equal(new SqlWhereBuilder().addIn('id', undefined).build().sql, '');
  });

  it('matches search terms case-insensitively across every listed column', () => {
    const where = new SqlWhereBuilder().addSearch('  AcMe  ', ['email', 'display_name']).build();
    assert.equal(
      where.sql,
      " WHERE (POSITION(? IN lower(coalesce(email, ''))) > 0" +
        " OR POSITION(? IN lower(coalesce(display_name, ''))) > 0)",
    );
    assert.deepEqual(where.params, ['acme', 'acme'], 'the term is trimmed and lowercased once');
  });

  it('treats LIKE wildcards in a search term as literal characters', () => {
    const where = new SqlWhereBuilder().addSearch('50%_off', ['name']).build();
    assert.deepEqual(where.params, ['50%_off'], 'POSITION needs no escaping');
  });

  it('ignores a blank or absent search term', () => {
    assert.equal(new SqlWhereBuilder().addSearch(undefined, ['name']).build().sql, '');
    assert.equal(new SqlWhereBuilder().addSearch('   ', ['name']).build().sql, '');
    assert.equal(new SqlWhereBuilder().addSearch('x', []).build().sql, '');
  });
});

describe('page', () => {
  it('defaults, clamps and floors', () => {
    assert.deepEqual(page(undefined), { limit: DEFAULT_PAGE_SIZE, offset: 0 });
    assert.deepEqual(page({ limit: 10, offset: 20 }), { limit: 10, offset: 20 });
    assert.equal(page({ limit: MAX_PAGE_SIZE + 500 }).limit, MAX_PAGE_SIZE);
    assert.equal(page({ limit: 0 }).limit, 1);
    assert.equal(page({ offset: -5 }).offset, 0);
    assert.equal(page({ offset: 3.7 }).offset, 3);
    assert.equal(page({ offset: Number.NaN }).offset, 0);
  });
});

describe('insertParts / setParts', () => {
  it('drops undefined columns from an INSERT', () => {
    const parts = insertParts({ id: 'a', name: 'n', missing: undefined, nulled: null });
    assert.equal(parts.names, 'id, name, nulled');
    assert.equal(parts.placeholders, '?, ?, ?');
    assert.deepEqual(parts.params, ['a', 'n', null]);
  });

  it('drops undefined columns from a SET, and returns null when none remain', () => {
    const set = setParts({ name: 'n', other: undefined, cleared: null });
    assert.equal(set?.sql, 'name = ?, cleared = ?');
    assert.deepEqual(set?.params, ['n', null]);
    assert.equal(setParts({ a: undefined, b: undefined }), null);
  });
});

describe('upsertSql', () => {
  it('uses ON CONFLICT … EXCLUDED for postgres', () => {
    assert.equal(
      upsertSql('pg', 'app_settings', ['"key"', 'value_json'], '"key"', ['value_json']),
      'INSERT INTO app_settings ("key", value_json) VALUES (?, ?) ' +
        'ON CONFLICT ("key") DO UPDATE SET value_json = EXCLUDED.value_json',
    );
  });

  it('uses the ON DUPLICATE KEY row alias for mysql', () => {
    assert.equal(
      upsertSql('mysql', 'app_settings', ['"key"', 'value_json'], '"key"', ['value_json']),
      'INSERT INTO app_settings ("key", value_json) VALUES (?, ?) ' +
        'AS new_row ON DUPLICATE KEY UPDATE value_json = new_row.value_json',
    );
  });
});

describe('column conversion', () => {
  it('decodes text, tolerating a nullable column', () => {
    assert.equal(text('abc'), 'abc');
    assert.equal(text(Buffer.from('abc')), 'abc');
    assert.equal(text(null), '');
    assert.equal(textOrNull(null), null);
    assert.equal(textOrNull(undefined), null);
    assert.equal(textOrNull('abc'), 'abc');
  });

  it('decodes 0/1 columns into booleans from every shape a driver may return', () => {
    assert.equal(bool(1), true);
    assert.equal(bool(0), false);
    assert.equal(bool(true), true);
    assert.equal(bool(false), false);
    assert.equal(bool('1'), true);
    assert.equal(bool('0'), false);
    assert.equal(bool(1n), true);
    assert.equal(bool(null), false);
  });

  it("decodes counts, including PostgreSQL's stringified bigints", () => {
    assert.equal(int(7), 7);
    assert.equal(int('7'), 7);
    assert.equal(int(7n), 7);
    assert.equal(int(null), 0);
  });

  it('round-trips JSON columns and falls back on null or garbage', () => {
    assert.deepEqual(json(encodeJson({ a: 1 }), null), { a: 1 });
    assert.equal(encodeJson(null), null);
    assert.equal(encodeJson(undefined), null);
    assert.deepEqual(json(null, { fallback: true }), { fallback: true });
    assert.deepEqual(json('not json', { fallback: true }), { fallback: true });
    assert.deepEqual(json('null', { fallback: true }), { fallback: true });
  });

  it('encodes booleans as 0/1', () => {
    assert.equal(encodeBool(true), 1);
    assert.equal(encodeBool(false), 0);
    assert.equal(encodeBool(undefined), 0);
  });
});

describe('mapSqlConflict', () => {
  it('passes a successful call straight through', async () => {
    assert.equal(await mapSqlConflict('nope', async () => 42), 42);
  });

  it('translates a PostgreSQL unique violation into CONFLICT', async () => {
    await assert.rejects(
      () =>
        mapSqlConflict('already taken', () => {
          throw Object.assign(new Error('duplicate key'), { code: '23505' });
        }),
      (error: unknown) =>
        isNexusError(error) && error.code === 'CONFLICT' && error.message === 'already taken',
    );
  });

  it('translates a MySQL duplicate entry into CONFLICT', async () => {
    await assert.rejects(
      () =>
        mapSqlConflict('already taken', () => {
          throw Object.assign(new Error('Duplicate entry'), { errno: 1062 });
        }),
      (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
    );
  });

  it('translates a foreign-key violation into CONFLICT with context', async () => {
    await assert.rejects(
      () =>
        mapSqlConflict('cannot link', () => {
          throw Object.assign(new Error('fk'), { code: '23503' });
        }),
      (error: unknown) =>
        isNexusError(error) &&
        error.code === 'CONFLICT' &&
        error.message.includes('referenced record'),
    );
  });

  it('re-throws anything that is not a constraint violation', async () => {
    await assert.rejects(
      () =>
        mapSqlConflict('unused', () => {
          throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        }),
      /connection reset/,
    );
  });
});
