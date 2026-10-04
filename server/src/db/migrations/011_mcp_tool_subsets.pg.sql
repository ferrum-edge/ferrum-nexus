-- Retained requests and grants keep the phase-1 all-published-tools meaning.
ALTER TABLE access_requests ADD COLUMN requested_tools_json TEXT DEFAULT NULL;
ALTER TABLE access_requests ADD COLUMN approved_tools_json TEXT DEFAULT NULL;
ALTER TABLE grants ADD COLUMN approved_tools_json TEXT DEFAULT NULL;
