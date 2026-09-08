import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { it } from 'node:test';
import { promisify } from 'node:util';

const runNode = promisify(execFile);
const adapterUrl = new URL('./index.ts', import.meta.url).href;
const helpersUrl = new URL('./sql.ts', import.meta.url).href;

// A native destructor can abort after assertions have passed. A separate process
// must reach natural exit successfully; a completion marker alone is insufficient.
for (const closeBeforeExit of [false, true]) {
  it(`SQLite survives GC and natural exit with close=${closeBeforeExit}`, async () => {
    const source = `
      import assert from 'node:assert/strict';
      import { openSqliteDatabase } from ${JSON.stringify(adapterUrl)};
      import { execute, queryOne, queryAll } from ${JSON.stringify(helpersUrl)};

      const db = openSqliteDatabase(':memory:');
      assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
      db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
      for (let batch = 0; batch < 10; batch += 1) {
        for (let i = 0; i < 100; i += 1) {
          const id = String(batch * 100 + i);
          assert.equal(execute(db, 'INSERT INTO items VALUES (?, ?)', [id, 'value']), 1);
          assert.deepEqual(queryOne(db, 'SELECT value FROM items WHERE id = ?', [id]), {
            value: 'value',
          });
        }
        globalThis.gc();
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(queryAll(db, 'SELECT id FROM items').length, 1000);
      assert.throws(db.transaction(() => {
        execute(db, 'INSERT INTO items VALUES (?, ?)', ['rolled-back', 'value']);
        throw new Error('rollback');
      }), /rollback/);
      assert.equal(queryOne(db, 'SELECT id FROM items WHERE id = ?', ['rolled-back']), undefined);

      // Retain some wrappers until teardown while collecting the short-lived ones.
      // Closing the database finalizes SQL handles but leaves JS wrappers to GC.
      globalThis.retained = [db, db.prepare('SELECT count(*) AS count FROM items')];
      assert.deepEqual(globalThis.retained[1].get(), { count: 1000 });
      if (${closeBeforeExit}) {
        db.close();
        assert.equal(db.open, false);
        assert.throws(() => globalThis.retained[1].get(), /not open/);
      }
      globalThis.gc();
      await new Promise((resolve) => setImmediate(resolve));
      process.stdout.write('sqlite-lifecycle-complete');
    `;
    const { stdout } = await runNode(
      process.execPath,
      ['--expose-gc', '--import', 'tsx', '--input-type=module', '--eval', source],
      { timeout: 30_000 },
    );
    assert.equal(stdout, 'sqlite-lifecycle-complete');
  });
}
