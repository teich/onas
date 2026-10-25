-- The `backups` collector's latest result (every 2 minutes) as one JSON document: PVE backup
-- jobs, PBS datastores, jobs, tasks and newest snapshot per group, and the host offsite job.
-- state.js turns it into coverage and findings (server/backups-model.js).
CREATE TABLE backup_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  collected_at INTEGER NOT NULL,  -- unix seconds
  data TEXT NOT NULL
);
