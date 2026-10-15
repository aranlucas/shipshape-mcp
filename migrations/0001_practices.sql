CREATE TABLE repositories (
  full_name TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
  installation_id INTEGER NOT NULL, private INTEGER NOT NULL, archived INTEGER NOT NULL,
  fork INTEGER NOT NULL, language TEXT, default_branch TEXT NOT NULL, pushed_at TEXT,
  html_url TEXT NOT NULL, synced_at TEXT NOT NULL
);
CREATE TABLE catalog (id INTEGER PRIMARY KEY CHECK (id = 1), repo TEXT NOT NULL, sha TEXT,
  loaded_at TEXT, practices_json TEXT NOT NULL DEFAULT '[]');
CREATE TABLE results (repo_full_name TEXT NOT NULL, practice_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pass','fail','unknown','not_applicable')),
  failing INTEGER NOT NULL DEFAULT 0, unknown INTEGER NOT NULL DEFAULT 0,
  checks_json TEXT NOT NULL DEFAULT '[]', head_sha TEXT, catalog_sha TEXT, checked_at TEXT,
  PRIMARY KEY (repo_full_name, practice_id));
CREATE INDEX results_by_practice ON results (practice_id, state);
CREATE TABLE sweep (id INTEGER PRIMARY KEY CHECK (id = 1), last_completed_at TEXT,
  pending INTEGER NOT NULL DEFAULT 0);
INSERT INTO sweep (id, pending) VALUES (1, 0);
