-- A durable append ordinal for gateway credential entries — PostgreSQL dialect.
--
-- Mirrors 011_credential_ordinal.sql, which carries the full rationale. In
-- short: Edge addresses credential entries only by array position, and the
-- position used to be reconstructed from `created_at`, which equal-millisecond
-- appends and clock steps reorder. `edge_ordinal` is a per-consumer, per-type
-- append counter the store assigns under the consumer lock; a live entry's
-- index is its rank among live rows ordered by it.
--
-- Existing rows are backfilled from the old sort only where no two live rows
-- of one consumer and type share a timestamp; ambiguous groups stay NULL and
-- need an administrator's reconciliation (`docs/operations.md` §12).

ALTER TABLE credential_metadata ADD COLUMN IF NOT EXISTS edge_ordinal INTEGER;

UPDATE credential_metadata
   SET edge_ordinal = (
     SELECT ranked.rn
       FROM (
         SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY ferrum_consumer_id, credential_type
                  ORDER BY created_at, id
                ) AS rn
           FROM credential_metadata
       ) AS ranked
      WHERE ranked.id = credential_metadata.id
   )
 WHERE NOT EXISTS (
   SELECT 1
     FROM credential_metadata AS a
     JOIN credential_metadata AS b
       ON b.ferrum_consumer_id = a.ferrum_consumer_id
      AND b.credential_type = a.credential_type
      AND b.created_at = a.created_at
      AND b.id <> a.id
    WHERE a.ferrum_consumer_id = credential_metadata.ferrum_consumer_id
      AND a.credential_type = credential_metadata.credential_type
      AND a.status <> 'revoked'
      AND b.status <> 'revoked'
 );

-- NULLs are distinct in a unique index, so unresolved legacy rows coexist;
-- two assigned ordinals can never collide within a consumer and type.
CREATE UNIQUE INDEX IF NOT EXISTS ux_credentials_ordinal
  ON credential_metadata (ferrum_consumer_id, credential_type, edge_ordinal);
