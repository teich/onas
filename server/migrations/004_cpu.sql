-- Where the host's CPU goes (the `cpu` collector, every 10 s), in host cores. Each run replaces
-- these tables as a whole. History goes to `metrics` as cpu.busy, cpu.iowait, cpu.c.<key>
-- (guests, services, kernel), cpu.k.<thread family>, zfs.arc.dnode_ratio and zfs.arc.prune_rate.

CREATE TABLE cpu_host (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sampled_at TEXT NOT NULL,
  interval_s REAL NOT NULL,
  cores INTEGER NOT NULL,       -- logical CPUs
  busy_cores REAL NOT NULL,     -- everything but idle and iowait
  iowait_cores REAL NOT NULL,   -- idle while waiting on disk; not counted as busy
  arc_size INTEGER,             -- ZFS ARC, bytes
  arc_target INTEGER,
  arc_max INTEGER,
  dnode_size INTEGER,           -- per-file metadata held in the ARC
  dnode_limit INTEGER,          -- past this, arc_prune works to evict dnodes
  arc_prune_rate REAL           -- arc_prune calls per second
);

CREATE TABLE cpu_consumers (
  key TEXT PRIMARY KEY,         -- guest-108, svc-pvestatd, user, kernel, k-arc_prune
  kind TEXT NOT NULL,           -- guest | service | kernel | kthread (kthreads are part of kernel)
  ref TEXT,                     -- vmid, systemd unit, or kernel thread family
  name TEXT,                    -- NULL for guests (named from the guests table)
  cores REAL NOT NULL
);
