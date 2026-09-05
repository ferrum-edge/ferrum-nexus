-- A durable append ordinal for gateway credential entries — SQLite dialect.
--
-- Ferrum Edge addresses a consumer's credentials of one type only as a
-- positional array: `POST` appends, `DELETE /{type}/{index}` removes by 0-based
-- index, and no entry carries an id. Nexus used to reconstruct an entry's index
-- by sorting its `credential_metadata` rows on `created_at` then `id`. That
-- order is not the append order: two appends inside one millisecond sort by a
-- random UUID, and a backward clock step puts the later append first — either
-- way a revoke could delete a *different* live key while marking the requested
-- one revoked.
--
-- `edge_ordinal` replaces the timestamp as the ordering key. It is a strictly
-- increasing counter per `(ferrum_consumer_id, credential_type)`, assigned by
-- the store as `MAX + 1` under the per-consumer lock every append already
-- holds, and never reused. A live entry's Edge index is its rank among the
-- consumer's live rows of that type ordered by this column.
--
-- Existing rows are backfilled from the old sort only where that sort is
-- unambiguous — no two live rows of the same consumer and type share a
-- timestamp. Where two do, the whole group is left NULL: nothing on either side
-- can say which entry is which, so those rows stay unaddressable until an
-- administrator reconciles the consumer (`docs/operations.md` §12). A backward
-- clock step cannot be detected after the fact and is accepted as the residual
-- risk for pre-existing rows; every row written from now on is exact.

ALTER TABLE credential_metadata ADD COLUMN edge_ordinal INTEGER;

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

-- NULLs are distinct here, so any number of unresolved legacy rows coexist;
-- two *assigned* ordinals can never collide within a consumer and type.
CREATE UNIQUE INDEX IF NOT EXISTS ux_credentials_ordinal
  ON credential_metadata (ferrum_consumer_id, credential_type, edge_ordinal);
