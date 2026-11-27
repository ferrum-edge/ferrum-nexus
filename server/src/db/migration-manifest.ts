/**
 * The shipped forward migrations, compiled into the server (docs/operations.md,
 * "Schema and upgrades").
 *
 * Every migration this build applies is listed here with the SHA-256 of each
 * backend's artifact: the `db/migrations/<id>.sql`, `.pg.sql` and `.mysql.sql`
 * files (text with CRLF normalised to LF) and the MongoDB step's canonical
 * form (`mongoMigration` in the MongoDB adapter). Because this list is code,
 * it survives packaging even when the SQL files do not: at startup
 * `loadShippedMigrations` refuses to run with a missing, extra or altered SQL
 * file, and `ci/check-image-schema.mjs` checks the built image the same way.
 * `frozen-baseline.test.ts` checks the source tree against it.
 *
 * Rules:
 *
 * 1. A schema change adds an entry, in id order, in the same change as its
 *    files and its `MONGO_MIGRATIONS` step. The test prints each checksum it
 *    computed.
 * 2. Until a release ships it, an entry's checksums may change with its
 *    artifacts. After that the entry and its artifacts are immutable: a fix is
 *    a new migration.
 *
 * The 1.0 baseline ships no migration.
 */

/** The backends a migration has an artifact for. */
export type MigrationBackend = 'sqlite' | 'pg' | 'mysql' | 'mongodb';

/** One shipped migration and the checksum of each backend's artifact. */
export interface MigrationManifestEntry {
  /** The id shared across backends, e.g. `016_add_widget_column`. */
  id: string;
  /** SHA-256 (hex) of each backend's artifact. */
  sha256: Readonly<Record<MigrationBackend, string>>;
}

/** Shipped migrations, in id order. */
export const MIGRATION_MANIFEST: readonly MigrationManifestEntry[] = [];
