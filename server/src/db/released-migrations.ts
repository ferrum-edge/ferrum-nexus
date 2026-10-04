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
    // Frozen: shipped in v0.3.0. Never edit these checksums; a schema change
    // is a new forward migration.
    release: 'v0.3.0',
    sha256: {
      sqlite: '76dc7de8351ff69555130094a29622fe7f4c1d3b8cc63698e5270e608af2109f',
      pg: '80b9248fea72c1e0f1f9468bcf76a85ec3050bcffc5ad0f81c4b462cb6274a97',
      mysql: 'c5d90d665a00a48f6d59ea5cf0a98bdf9650f7d54f720b188d5239c15407482c',
      mongodb: '42aa5064cff7a2841c149229816fa7137f04eef4da2e418fb188202d948d1d1a',
    },
  },
  {
    id: '005_notification_preferences',
    // Frozen: shipped in v0.3.0. Never edit these checksums; a schema change
    // is a new forward migration.
    release: 'v0.3.0',
    sha256: {
      sqlite: '96d6a280449b306703c388e57f1a53b313718874cc06a042626231f38373fce4',
      pg: 'f138bdc749c7c27154ae6b1ea446c4c8913f15561186bdf609a3517bb9956cc7',
      mysql: '7776d9ee44ab8dd4897a8c9d31a90dd81a697d02bacf3447a270c5863b1ed2e0',
      mongodb: '1a719fae713931afb77416cd2dd59b2f43ef86cfe463351e0fe55a285424baf9',
    },
  },
  {
    id: '006_user_identities',
    // Frozen: shipped in v0.3.0. Never edit these checksums; a schema change
    // is a new forward migration.
    release: 'v0.3.0',
    sha256: {
      sqlite: 'ba9869babb2b77996d199e56eff0312e36bbe7874d086cb28cd2e3da8a4e7c80',
      pg: '651405188176fc2b371abd78c43c2a4bbd69712ceca9a71c094cb30d032d1307',
      mysql: '83bc479c003f1cc5d5c3e54d7eb1ebbd8a7e429d556a374ef7644de175a9e521',
      mongodb: '34cadaedbbe3f1ad75e15f20d2e9f36bcd2faa5010887b4e3b2f0b2f279aaa0f',
    },
  },
  {
    id: '007_outbox_recipient',
    release: null,
    sha256: {
      sqlite: '3542a52ac9d4899998982c35cebf711874171dc2e64e6cce93c511320e2d1c9f',
      pg: '3542a52ac9d4899998982c35cebf711874171dc2e64e6cce93c511320e2d1c9f',
      mysql: 'ba0e61f19bace531851540f33c5f3b21fe6f5ecef4e74b55fb2b67da904497db',
      mongodb: '2420be3f83a7ac8679b542a86da48368bdaf0652e7ab9de3f4cfbafb61678afd',
    },
  },
  {
    id: '008_email_lifecycle_fence',
    release: null,
    sha256: {
      sqlite: 'e045e7cd6c1fe5185b48407fba1a184f013a144f0e814795bc57dcce367fb228',
      pg: 'e045e7cd6c1fe5185b48407fba1a184f013a144f0e814795bc57dcce367fb228',
      mysql: 'e188654d23f1adc941b96a04343f51d018ff31220792ae03d9280a8592c80d5c',
      mongodb: 'e9ce02f689b67ecf81d7c44c58bb8e6c4d37f38a30fcf9936458b51b5deba891',
    },
  },
  {
    id: '009_outbox_priority',
    release: null,
    sha256: {
      sqlite: '0ffa16cce8d5a154877a1dadffc52b8ac3ad4cc8346d637b008ded2ec5fde31e',
      pg: '6bd48d66f70cd8b949dc168991e822db31ae49d3734b3cbcee81115b0d6c8b35',
      mysql: '633e786effcf93732d5b53987e42e3118bf789394b57295a3764440a69cddc16',
      mongodb: '69cb26f63681690067159841eaab59788cc075a07beb7bdda3634c22fbfa635c',
    },
  },
  {
    id: '010_api_agents',
    release: null,
    sha256: {
      sqlite: '6c443c5d865775a981fe81c31ba8b5b014db89a9327e3bfcdf5ba54368a04cdb',
      pg: '6c443c5d865775a981fe81c31ba8b5b014db89a9327e3bfcdf5ba54368a04cdb',
      mysql: '596173cf1eeb814be551f563a6c449724146b7969e2c4cc2441d879048846da7',
      mongodb: '88ac21c744286dcc8b737e6fa07440f44fa6afda872ac466154487a143cb94c2',
    },
  },
];
