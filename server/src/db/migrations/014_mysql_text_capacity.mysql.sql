-- Values the API accepts must fit the columns that store them (issues #604
-- and #605). TEXT holds 65,535 bytes: an audit row for an agents update can
-- carry 256 tool descriptions of 2,048 characters each, and an OpenAPI
-- document's info.title and info.version have no length limit of their own
-- beyond the 2 MiB document. LONGTEXT matches the other JSON and spec columns.
-- Each change keeps the column's nullability, default and table collation.
ALTER TABLE audit_logs MODIFY COLUMN details_json LONGTEXT NOT NULL DEFAULT ('{}');
ALTER TABLE api_specs MODIFY COLUMN parsed_title LONGTEXT DEFAULT NULL;
ALTER TABLE api_specs MODIFY COLUMN parsed_version LONGTEXT DEFAULT NULL;
