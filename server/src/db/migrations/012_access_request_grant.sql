-- A request for more tools on an existing grant names that grant.
-- Retained requests stay requests for access.
ALTER TABLE access_requests ADD COLUMN grant_id TEXT NULL;
