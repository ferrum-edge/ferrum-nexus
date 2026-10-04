-- Agent exposure is off for every retained API. Selections are Nexus-owned JSON.
ALTER TABLE apis ADD COLUMN agents_json LONGTEXT DEFAULT NULL;
