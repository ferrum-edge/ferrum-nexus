-- Ferrum Nexus 005 — per-account notification preferences (MySQL 8 dialect).
--
-- Mirrors 005_notification_preferences.sql; see there for what the table
-- records. A single replayable CREATE with its keys and constraints inline,
-- which is the only statement shape the MySQL migration runner applies.
CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id                 VARCHAR(64) NOT NULL,
  api_spec_updated_in_app TINYINT     NOT NULL DEFAULT 1,
  api_spec_updated_email  TINYINT     NOT NULL DEFAULT 1,
  created_at              VARCHAR(32) NOT NULL,
  updated_at              VARCHAR(32) NOT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT ck_user_notification_preferences_in_app CHECK (api_spec_updated_in_app IN (0, 1)),
  CONSTRAINT ck_user_notification_preferences_email CHECK (api_spec_updated_email IN (0, 1)),
  CONSTRAINT fk_user_notification_preferences_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
