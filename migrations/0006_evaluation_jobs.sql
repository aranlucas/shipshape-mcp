CREATE TABLE evaluation_runs (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  request_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at TEXT
);
CREATE TABLE evaluation_heads (
  repo_full_name TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES evaluation_runs(id)
);
CREATE TABLE evaluation_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES evaluation_runs(id),
  repo_full_name TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  practice_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'running', 'completed', 'failed', 'superseded')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  lease_token TEXT,
  lease_until INTEGER,
  failure TEXT,
  completed_at TEXT
);
CREATE INDEX evaluation_jobs_dispatch ON evaluation_jobs(status, dispatched_at, available_at);
CREATE INDEX evaluation_jobs_run ON evaluation_jobs(run_id, status);
CREATE INDEX evaluation_jobs_repo ON evaluation_jobs(repo_full_name, run_id);

-- Maintain the existing API projection from job states, never delivery counts.
CREATE TRIGGER evaluation_jobs_insert AFTER INSERT ON evaluation_jobs BEGIN
  UPDATE sweep SET pending = (
    SELECT COUNT(*) FROM evaluation_jobs WHERE status IN ('pending', 'running')
  ) WHERE id = 1;
  UPDATE evaluation_runs SET completed_at = NULL WHERE id = NEW.run_id;
END;
CREATE TRIGGER evaluation_jobs_status AFTER UPDATE OF status ON evaluation_jobs
WHEN OLD.status <> NEW.status BEGIN
  UPDATE sweep SET
    pending = (SELECT COUNT(*) FROM evaluation_jobs WHERE status IN ('pending', 'running')),
    last_completed_at = CASE WHEN
      NOT EXISTS (SELECT 1 FROM evaluation_jobs WHERE status IN ('pending', 'running'))
      THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE last_completed_at END
  WHERE id = 1;
  UPDATE evaluation_runs SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.run_id AND NOT EXISTS (
    SELECT 1 FROM evaluation_jobs WHERE run_id = NEW.run_id AND status IN ('pending', 'running')
  );
END;
