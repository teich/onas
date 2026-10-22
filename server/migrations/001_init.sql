-- Current state. Each collector replaces its tables as a whole on every successful run.

CREATE TABLE host (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hostname TEXT,
  kernel TEXT,
  pve_version TEXT,
  cpu REAL,              -- fraction 0..1
  cores INTEGER,
  mem_total INTEGER,
  mem_used INTEGER,
  swap_total INTEGER,
  swap_used INTEGER,
  load1 REAL,
  load5 REAL,
  load15 REAL,
  uptime INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE guests (
  vmid INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,    -- lxc | vm
  status TEXT NOT NULL,
  tags TEXT,
  lock TEXT,
  uptime INTEGER,
  cpu REAL,
  maxcpu INTEGER,
  mem INTEGER,
  maxmem INTEGER,
  disk INTEGER,
  maxdisk INTEGER,
  netin INTEGER,
  netout INTEGER,
  netin_rate REAL,       -- bytes/s since the previous sample
  netout_rate REAL,
  diskread INTEGER,
  diskwrite INTEGER
);

CREATE TABLE pools (
  name TEXT PRIMARY KEY,
  size INTEGER,
  alloc INTEGER,
  free INTEGER,
  frag INTEGER,
  dedup REAL,
  health TEXT,
  scan TEXT,
  errors TEXT,
  status TEXT,
  vdevs TEXT             -- JSON tree from /nodes/{node}/disks/zfs/{pool}
);

CREATE TABLE datasets (
  name TEXT PRIMARY KEY,
  used INTEGER,
  avail INTEGER,
  refer INTEGER,
  mountpoint TEXT,
  type TEXT,
  volsize INTEGER
);

CREATE TABLE snapshots (
  name TEXT PRIMARY KEY,
  dataset TEXT NOT NULL,
  snapname TEXT NOT NULL,
  used INTEGER,
  refer INTEGER,
  created_at TEXT
);
CREATE INDEX snapshots_dataset ON snapshots (dataset);

CREATE TABLE disks (
  devpath TEXT PRIMARY KEY,
  by_id TEXT,
  model TEXT,
  serial TEXT,
  type TEXT,
  size INTEGER,
  used TEXT,
  health TEXT,
  wearout INTEGER,
  temp_c INTEGER,
  power_on_hours INTEGER,
  reallocated INTEGER
);

CREATE TABLE updates (
  package TEXT PRIMARY KEY,
  old_version TEXT,
  version TEXT,
  kind TEXT,             -- patch | update | upgrade
  origin TEXT,
  priority TEXT
);

CREATE TABLE shares (
  name TEXT PRIMARY KEY,
  path TEXT,
  comment TEXT,
  read_only INTEGER,
  guest_ok INTEGER,
  browseable INTEGER,
  inherit_permissions INTEGER
);

CREATE TABLE smb_users (
  username TEXT PRIMARY KEY,
  full_name TEXT
);

-- History

CREATE TABLE metrics (
  series TEXT NOT NULL,  -- host.cpu, host.mem, guest.103.cpu, guest.103.netin ...
  ts INTEGER NOT NULL,   -- unix seconds
  value REAL NOT NULL,
  PRIMARY KEY (series, ts)
) WITHOUT ROWID;

CREATE TABLE metrics_5m (
  series TEXT NOT NULL,
  ts INTEGER NOT NULL,   -- start of the 5-minute bucket
  avg REAL NOT NULL,
  max REAL NOT NULL,
  PRIMARY KEY (series, ts)
) WITHOUT ROWID;

-- Bookkeeping

CREATE TABLE collector_runs (
  id INTEGER PRIMARY KEY,
  collector TEXT NOT NULL,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT,
  via TEXT               -- api | ssh | local
);
CREATE INDEX collector_runs_latest ON collector_runs (collector, id);

CREATE TABLE actions (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,   -- ui (agents later)
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  ok INTEGER NOT NULL,
  exit_code INTEGER,
  output TEXT
);
