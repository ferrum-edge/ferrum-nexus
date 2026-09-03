-- Provider-editable Edge proxy settings: method allow-list, backend timeouts
-- and the circuit breaker — PostgreSQL dialect.
--
-- Mirrors 004_api_proxy_settings.sql column for column. `allowed_methods_json`
-- and `timeouts_json` are JSON text decoded at the adapter boundary exactly
-- like `rate_limit_json` and `cors_json`; NULL means the provider set nothing,
-- so the proxy accepts every method and keeps the gateway's own timeout
-- defaults. `circuit_breaker` is NOT NULL DEFAULT 0 so pre-existing rows read
-- back as "no breaker", which is what their proxies already have.

ALTER TABLE apis ADD COLUMN IF NOT EXISTS allowed_methods_json TEXT NULL;
ALTER TABLE apis ADD COLUMN IF NOT EXISTS timeouts_json TEXT NULL;
ALTER TABLE apis ADD COLUMN IF NOT EXISTS circuit_breaker SMALLINT NOT NULL DEFAULT 0
  CHECK (circuit_breaker IN (0, 1));
