CREATE TABLE github_snapshot_cache (
  installation_id INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  resource TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, repo_full_name, head_sha, resource)
);
CREATE INDEX github_snapshot_cache_expiry ON github_snapshot_cache (expires_at);
