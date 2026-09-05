-- A durable append ordinal for gateway credential entries — MySQL 8 dialect.
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
--
-- MySQL refuses a subquery on the table being updated (error 1093), so the
-- backfill is a multi-table UPDATE over two derived tables. Both are
-- non-mergeable — one carries a window function, the other a DISTINCT — which
-- is what keeps the optimizer from folding them back into the target table.

ALTER TABLE credential_metadata
  ADD COLUMN edge_ordinal INT DEFAULT NULL;

UPDATE credential_metadata AS cm
  JOIN (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY ferrum_consumer_id, credential_type
             ORDER BY created_at, id
           ) AS rn
      FROM credential_metadata
  ) AS ranked
    ON ranked.id = cm.id
  LEFT JOIN (
    SELECT DISTINCT a.ferrum_consumer_id, a.credential_type
      FROM credential_metadata AS a
      JOIN credential_metadata AS b
        ON b.ferrum_consumer_id = a.ferrum_consumer_id
       AND b.credential_type = a.credential_type
       AND b.created_at = a.created_at
       AND b.id <> a.id
     WHERE a.status <> 'revoked'
       AND b.status <> 'revoked'
  ) AS ambiguous
    ON ambiguous.ferrum_consumer_id = cm.ferrum_consumer_id
   AND ambiguous.credential_type = cm.credential_type
   SET cm.edge_ordinal = ranked.rn
 WHERE ambiguous.ferrum_consumer_id IS NULL;

-- InnoDB allows any number of NULLs under a UNIQUE KEY, so unresolved legacy
-- rows coexist; two assigned ordinals can never collide within a consumer and
-- type.
ALTER TABLE credential_metadata
  ADD UNIQUE KEY ux_credentials_ordinal (ferrum_consumer_id, credential_type, edge_ordinal);
