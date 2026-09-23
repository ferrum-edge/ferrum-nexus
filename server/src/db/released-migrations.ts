/**
 * The released-migration manifest (issue #286).
 *
 * Every migration listed here is part of a schema a supported release shipped
 * — or, while its `release` is still `null`, the baseline the first supported
 * release will freeze. `released-migrations.test.ts` hashes each backend's
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
 * 2. Until then (`release: null`, the buildout baseline), `001_initial` is still
 *    edited in place, and each edit updates its checksums here in the same
 *    change. The test prints the value it computed.
 * 3. The release step that ships a schema sets `release` on every entry it
 *    ships and adds an entry for each new migration. It never edits a
 *    checksum of an entry that already has a `release`.
 */

/** One backend's artifact for a migration id. */
export type ReleasedMigrationBackend = 'sqlite' | 'pg' | 'mysql' | 'mongodb';

/** A shipped (or about-to-ship) migration and the checksums that freeze it. */
export interface ReleasedMigration {
  /** Migration id shared across backends, e.g. `001_initial`. */
  id: string;
  /**
   * The Nexus release that first shipped it, or `null` for the baseline still
   * awaiting the first supported release.
   */
  release: string | null;
  /** SHA-256 (hex) of each backend's artifact. */
  sha256: Readonly<Record<ReleasedMigrationBackend, string>>;
}

/** Released migrations, in id order. */
export const RELEASED_MIGRATIONS: readonly ReleasedMigration[] = [
  {
    id: '001_initial',
    // RELEASE STEP: to be frozen at the first supported release. Set this to
    // that release's version when it is published, and do not change the
    // checksums below in the same edit.
    release: null,
    sha256: {
      sqlite: 'd9d9e14105fdbf22b2b167dac1b72949dc4f8bd5758c7ec5d66ca209a86efe0f',
      pg: '00fb94f713a187b44160e4728180b251e95584d0dd8db2f577533216cdf872c1',
      mysql: '7aebee40d3c2990e25dacc114af667bfd62fa700b83d9464b3dbacd9eea4d720',
      mongodb: '73abead7908c20263d073ef44076ab747598b4f817709d09ccb2368e5fba55c6',
    },
  },
];
