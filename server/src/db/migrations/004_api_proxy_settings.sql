-- Provider-editable Edge proxy settings: method allow-list, backend timeouts
-- and the circuit breaker — SQLite dialect.
--
-- `allowed_methods_json` and `timeouts_json` follow the existing
-- `rate_limit_json` / `cors_json` convention: JSON text, decoded at the
-- adapter boundary. NULL means "not set by the provider", which is *not* the
-- same as an empty list: NULL `allowed_methods_json` leaves the proxy
-- accepting every method, and NULL `timeouts_json` leaves the gateway's own
-- defaults (5000 / 30000 / 30000 ms) in place.
--
-- `circuit_breaker` is a plain 0/1 flag rather than a config blob: the portal
-- only offers on/off and writes Edge's default `CircuitBreakerConfig` when it
-- is on. It is NOT NULL with a 0 default so pre-existing rows read back as
-- "no breaker", which is what their proxies already have.

ALTER TABLE apis ADD COLUMN allowed_methods_json TEXT NULL;
ALTER TABLE apis ADD COLUMN timeouts_json TEXT NULL;
ALTER TABLE apis ADD COLUMN circuit_breaker INTEGER NOT NULL DEFAULT 0 CHECK (circuit_breaker IN (0, 1));
