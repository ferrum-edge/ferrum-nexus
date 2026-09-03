-- Provider-editable Edge proxy settings: method allow-list, backend timeouts
-- and the circuit breaker — MySQL 8 dialect.
--
-- Mirrors 004_api_proxy_settings.sql column for column. `allowed_methods_json`
-- and `timeouts_json` are JSON text decoded at the adapter boundary exactly
-- like `rate_limit_json` and `cors_json`; NULL means the provider set nothing,
-- so the proxy accepts every method and keeps the gateway's own timeout
-- defaults. `circuit_breaker` is a TINYINT flag, NOT NULL DEFAULT 0 so
-- pre-existing rows read back as "no breaker" — matching what their proxies
-- already have — and follows 001's convention of leaving the 0/1 domain to the
-- adapter rather than a CHECK constraint.
--
-- MySQL has no `ADD COLUMN IF NOT EXISTS` and no transactional DDL, so all
-- three columns are added by a single ALTER: a half-applied migration would be
-- left pending by the runner and fail on the retry.

ALTER TABLE apis
  ADD COLUMN allowed_methods_json TEXT    NULL,
  ADD COLUMN timeouts_json        TEXT    NULL,
  ADD COLUMN circuit_breaker      TINYINT NOT NULL DEFAULT 0;
