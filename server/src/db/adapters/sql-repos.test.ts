/**
 * Statement-level checks for the shared PostgreSQL/MySQL repositories.
 *
 * No database is involved: the repos run over a recording executor, so these
 * pin *what is asked of the server*, which the behavioural smoke suite cannot
 * see. Results are covered there, on every adapter.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Row, SqlDialect, SqlExecutor, SqlTransactionRunner } from './sql-common.js';
import { createSqlRepos } from './sql-repos.js';

/** An executor that records every statement and returns no rows. */
function recordingExecutor(dialect: SqlDialect): { exec: SqlExecutor; statements: string[] } {
  const statements: string[] = [];
  const exec: SqlExecutor = {
    dialect,
    query: async (sql: string): Promise<Row[]> => {
      statements.push(sql);
      return [];
    },
    execute: async (sql: string): Promise<number> => {
      statements.push(sql);
      return 0;
    },
  };
  return { exec, statements };
}

for (const dialect of ['pg', 'mysql'] as const) {
  describe(`sql-repos apiSpecs summary reads (${dialect})`, () => {
    it('never select the document', async () => {
      const { exec, statements } = recordingExecutor(dialect);
      const runner: SqlTransactionRunner = (fn) => fn(exec);
      const repos = createSqlRepos(exec, runner);

      assert.equal(await repos.apiSpecs.findCurrentSummaryByApi('api-1'), null);
      assert.deepEqual(
        await repos.apiSpecs.listSummaries({ api_id: 'api-1' }, { limit: 5, offset: 5 }),
        { items: [], total: 0 },
      );

      const selects = statements.filter((sql) => /^\s*SELECT/i.test(sql));
      assert.equal(selects.length, 3, 'the current row, the count and one page');
      for (const sql of selects) {
        assert.doesNotMatch(sql, /raw_spec/, sql);
        assert.doesNotMatch(sql, /SELECT\s+\*/i, sql);
      }
      // The page keeps the listing order the full read uses.
      assert.match(selects[2] ?? '', /ORDER BY is_current DESC, revision_seq DESC/);
    });

    it('the full reads still select it', async () => {
      const { exec, statements } = recordingExecutor(dialect);
      const runner: SqlTransactionRunner = (fn) => fn(exec);
      const repos = createSqlRepos(exec, runner);

      await repos.apiSpecs.findCurrentByApi('api-1');
      await repos.apiSpecs.list({ api_id: 'api-1' });

      // The check above is not vacuous: the document-carrying reads are `*`.
      const full = statements.filter((sql) => /^SELECT \* FROM api_specs/.test(sql));
      assert.equal(full.length, 2, statements.join('\n'));
    });
  });
}
