-- Latest live hardware sample (the `hardware` collector, every 10 s). Each run replaces these
-- tables as a whole. History goes to `metrics` as disk.<serial>.{read,write,busy,temp},
-- nic.<name>.{rx,tx} and cpu.temp.

-- One row: when the sample was taken and the host temperatures that belong to no disk or NIC.
CREATE TABLE hw_host (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sampled_at TEXT NOT NULL,
  interval_s REAL NOT NULL,     -- seconds between the last two samples; 0 on the first run
  cpu_temp_c REAL               -- k10temp Tctl
);

-- DIMM temperatures (spd5118), slot ram1, ram2 ...
CREATE TABLE hw_memory (
  slot TEXT PRIMARY KEY,
  temp_c REAL
);

CREATE TABLE hw_disks (
  name TEXT PRIMARY KEY,        -- sda, nvme1n1
  pos INTEGER NOT NULL,         -- display order
  serial TEXT NOT NULL,
  kind TEXT NOT NULL,           -- hdd | nvme
  port TEXT NOT NULL,           -- ata-3, or the NVMe controller's PCI address
  slot TEXT,                    -- bay1.., m2s1..
  slot_source TEXT NOT NULL,    -- config | assumed
  read_bps REAL NOT NULL,
  write_bps REAL NOT NULL,
  read_iops REAL NOT NULL,
  write_iops REAL NOT NULL,
  busy_pct REAL NOT NULL,
  temp_c REAL,
  temp_at TEXT,                 -- when temp_c was read (HDDs: last smartctl, kept while in standby)
  standby INTEGER               -- 1 spun down, 0 spinning, NULL unknown / not an HDD
);

CREATE TABLE hw_nics (
  name TEXT PRIMARY KEY,        -- enp101s0
  pos INTEGER NOT NULL,
  slot TEXT,                    -- lan1, lan2, sfp1, sfp2
  slot_source TEXT NOT NULL,    -- config | assumed
  kind TEXT NOT NULL,
  up INTEGER NOT NULL,          -- carrier
  speed_mbps INTEGER,
  rx_bps REAL NOT NULL,
  tx_bps REAL NOT NULL
);
