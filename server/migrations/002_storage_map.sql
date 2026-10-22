-- Space breakdown per dataset, so snapshot overhead and quotas are visible.
ALTER TABLE datasets ADD COLUMN used_by_snapshots INTEGER;
ALTER TABLE datasets ADD COLUMN used_by_dataset INTEGER;
ALTER TABLE datasets ADD COLUMN used_by_children INTEGER;
ALTER TABLE datasets ADD COLUMN quota INTEGER;
ALTER TABLE datasets ADD COLUMN compressratio REAL;

-- What each guest mounts: root disks, VM disks and bind mounts, resolved to a dataset where
-- possible. This is what connects datasets to the services and shares that use them.
CREATE TABLE guest_mounts (
  vmid INTEGER NOT NULL,
  slot TEXT NOT NULL,          -- rootfs, mp0, scsi0, efidisk0 ...
  kind TEXT NOT NULL,          -- rootfs | bind | disk
  source TEXT NOT NULL,        -- fast:subvol-103-disk-0 or /bulk/photos
  target TEXT,                 -- mount point inside the guest (LXC only)
  dataset TEXT,                -- resolved ZFS dataset, if any
  read_only INTEGER NOT NULL DEFAULT 0,
  size TEXT,
  PRIMARY KEY (vmid, slot)
);

-- Who's connected to Samba right now (smbstatus).
CREATE TABLE smb_connections (
  id INTEGER PRIMARY KEY,
  share TEXT NOT NULL,
  username TEXT,
  machine TEXT,
  connected_at TEXT,
  encryption TEXT,
  open_files INTEGER NOT NULL DEFAULT 0
);

-- 5-minute history now comes from Proxmox's own RRD data (backfilled, then kept current),
-- which also carries pressure-stall metrics. Raw 10-second samples stay for live views.
DELETE FROM metrics_5m;
