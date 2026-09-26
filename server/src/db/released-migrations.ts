/**
 * The released-migration manifest (issue #286).
 *
 * Every migration listed here is part of a schema a supported release shipped
 * — or, while its `release` is still `null`, one the next release will ship
 * and freeze. `released-migrations.test.ts` hashes each backend's
 * artifact and fails when it no longer matches, so an edit to a shipped
 * migration is caught in CI instead of in an operator's upgrade:
 *
 * - `sqlite` / `pg` / `mysql`: the `db/migrations/<id>.sql`, `.pg.sql` and
 *   `.mysql.sql` files;
 * - `mongodb`: `db/released/<id>.mongodb.json`, the committed snapshot of the
 *   step's declared indexes, which the same test compares with the live
 *   definition in `adapters/mongodb/index.ts`.
 *
 * A checksum is the SHA-256 of the file's UTF-8 text with CRLF line endings
 * normalised to LF, so `shasum -a 256 <file>` on an LF checkout reproduces it.
 *
 * Rules (docs/operations.md, "Schema versioning and upgrades"):
 *
 * 1. After `release` is set, the entry and its artifacts are immutable. A
 *    schema change after that point is a **new forward migration** with a
 *    higher id — never an edit, rename, reorder or deletion of a listed one.
 * 2. A new forward migration is listed here with `release: null` in the change
 *    that adds it, so its artifacts are checked from then on. Until it ships,
 *    they may still change, and each edit updates its checksums here in the
 *    same change. The test prints the value it computed. `001_initial` was
 *    edited this way during buildout and frozen by `v0.1.0`.
 * 3. The release step that ships a schema sets `release` on every pending
 *    entry it ships. It never edits a checksum of an entry that already has a
 *    `release`.
 */

/** One backend's artifact for a migration id. */
export type ReleasedMigrationBackend = 'sqlite' | 'pg' | 'mysql' | 'mongodb';

/** A shipped (or about-to-ship) migration and the checksums that freeze it. */
export interface ReleasedMigration {
  /** Migration id shared across backends, e.g. `001_initial`. */
  id: string;
  /**
   * The Nexus release that first shipped it, or `null` for a migration still
   * awaiting its release.
   */
  release: string | null;
  /** SHA-256 (hex) of each backend's artifact. */
  sha256: Readonly<Record<ReleasedMigrationBackend, string>>;
}

/** Released migrations, in id order. */
export const RELEASED_MIGRATIONS: readonly ReleasedMigration[] = [
  {
    id: '001_initial',
    // Frozen: the baseline the first supported release shipped. Never edit
    // these checksums; a schema change is a new forward migration.
    release: 'v0.1.0',
    sha256: {
      sqlite: 'd9d9e14105fdbf22b2b167dac1b72949dc4f8bd5758c7ec5d66ca209a86efe0f',
      pg: '00fb94f713a187b44160e4728180b251e95584d0dd8db2f577533216cdf872c1',
      mysql: '7aebee40d3c2990e25dacc114af667bfd62fa700b83d9464b3dbacd9eea4d720',
      mongodb: '5009017f5c98354dcb0581a4fafc5fef003863be1413992280beb85e2f1ab83e',
    },
  },
  {
    id: '002_api_gateway_plugins',
    // Pending: the next release sets `release`. Until then an edit to its
    // artifacts updates these checksums in the same change.
    release: null,
    sha256: {
      sqlite: '60a1cca8245753350feca41756af35b06094f238de935a798ec191f3bdb0fc2b',
      pg: 'c16ac5c1318044e96909d6c9b16a388fb66550163927497be9458c132cda3679',
      mysql: 'c6430b84d851998a49a6da79624749286a36560fcd624c0110957d737df2c360',
      mongodb: '00e15264f7de04cb8bb29dc59bb2f013582a024ee0cb9eb024918e4997ff17dc',
    },
  },
];
