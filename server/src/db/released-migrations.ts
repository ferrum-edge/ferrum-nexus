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
    // Frozen: shipped in v0.2.0. Never edit these checksums; a schema change
    // is a new forward migration.
    release: 'v0.2.0',
    sha256: {
      sqlite: '60a1cca8245753350feca41756af35b06094f238de935a798ec191f3bdb0fc2b',
      pg: 'c16ac5c1318044e96909d6c9b16a388fb66550163927497be9458c132cda3679',
      mysql: 'c6430b84d851998a49a6da79624749286a36560fcd624c0110957d737df2c360',
      mongodb: '00e15264f7de04cb8bb29dc59bb2f013582a024ee0cb9eb024918e4997ff17dc',
    },
  },
  {
    id: '003_messages_thread_latest',
    // Frozen: shipped in v0.2.0. Never edit these checksums; a schema change
    // is a new forward migration.
    release: 'v0.2.0',
    sha256: {
      sqlite: '8a5c81214aeab27665631cabbc44342f052c99a280a698492de1ed209ce7a751',
      pg: '7ddd30ac68ef9e5e1694794bbbd10b7c8a47ac25ce3aa0a28473d829885fbaec',
      mysql: '53ca8bd32bb8e812396a366307747afb877552999a3d06bcfacd3014ba3cbbca',
      mongodb: '0e9319c397b60336397b54a85d2bd9a52aa398d555d7457752ebe0a234993b9e',
    },
  },
  {
    id: '004_api_spec_changes',
    // Pending: ships with the next release, which sets `release`.
    release: null,
    sha256: {
      sqlite: '76dc7de8351ff69555130094a29622fe7f4c1d3b8cc63698e5270e608af2109f',
      pg: '80b9248fea72c1e0f1f9468bcf76a85ec3050bcffc5ad0f81c4b462cb6274a97',
      mysql: 'c5d90d665a00a48f6d59ea5cf0a98bdf9650f7d54f720b188d5239c15407482c',
      mongodb: '42aa5064cff7a2841c149229816fa7137f04eef4da2e418fb188202d948d1d1a',
    },
  },
  {
    id: '005_notification_preferences',
    // Pending: ships with the next release, which sets `release`.
    release: null,
    sha256: {
      sqlite: 'b26e8fc1197a503559de192683df702eb52dc0c04d33f623d20579025e2e140e',
      pg: 'cea3d055637e66e4a4f2483ad89ad6589507296fcca3f09b4f23a6a50ca36517',
      mysql: 'aabda4941d0c09af4abfd5b0cf8ad6f1ea2ae7ada6dc899f861322953c610e10',
      mongodb: '1a719fae713931afb77416cd2dd59b2f43ef86cfe463351e0fe55a285424baf9',
    },
  },
];
