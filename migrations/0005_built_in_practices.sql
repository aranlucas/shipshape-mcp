-- Built-in practices ship with the Worker; the catalog row stores only the
-- catalog repository's layer. built_in_version records which bundled set the
-- stored results were last requeued for; disabled_json lists built-in ids the
-- catalog turns off.
ALTER TABLE catalog ADD COLUMN built_in_version TEXT;
ALTER TABLE catalog ADD COLUMN disabled_json TEXT NOT NULL DEFAULT '[]';
