-- God-mode broadcast subjects reach 300 characters at the route, but MySQL
-- declared both columns they land in as VARCHAR(255), so a 256–300 character
-- subject returned ER_DATA_TOO_LONG on MySQL alone. PostgreSQL and SQLite store
-- these columns as unbounded TEXT and need no change; see the companion no-op
-- dialect files. Widen both columns together so the two writes in `broadcast`
-- cannot desynchronise around a split fix.

ALTER TABLE notifications MODIFY COLUMN title VARCHAR(300) NOT NULL;
ALTER TABLE message_threads MODIFY COLUMN subject VARCHAR(300) NOT NULL;