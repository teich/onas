// Vdev tree as returned by the Proxmox API (/nodes/{node}/disks/zfs/{pool}).
export interface Vdev {
  name: string;
  state: string;
  read: number;
  write: number;
  cksum: number;
  leaf: number;
  msg?: string;
  children?: Vdev[];
}

export interface Pool {
  name: string;
  size: number;
  alloc: number;
  free: number;
  frag: number;
  cap: number;
  dedup: number;
  health: string;
  scan: string;
  errors: string;
  status: string;
  vdevs: Vdev[];
}

export interface Dataset {
  name: string;
  used: number;
  avail: number;
  refer: number;
  mountpoint: string;
  type: string;
  volsize: number | null;
  usedBySnapshots: number;
  usedByDataset: number;
  usedByChildren: number;
  quota: number | null;
  compressratio: number | null;
}

export interface GuestMount {
  vmid: number;
  slot: string;
  kind: 'rootfs' | 'bind' | 'disk';
  source: string;
  target: string | null;
  dataset: string | null;
  readOnly: boolean;
  size: string | null;
}

export interface SmbConnection {
  share: string;
  username: string;
  machine: string;
  connectedAt: string | null;
  encryption: string;
  openFiles: number;
}

export interface HistoryMatrix {
  metric: string;
  hours: number;
  step: number;
  start: number;
  end: number;
  max: number;
  series: Array<{ id: string; values: Array<number | null> }>;
}

export interface Snapshot {
  name: string;
  dataset: string;
  snapname: string;
  usedBytes: number;
  referBytes: number;
  createdAt: string;
}

export interface Guest {
  vmid: number;
  name: string;
  status: 'running' | 'stopped' | 'paused' | 'booting' | 'stopping' | 'error' | 'unknown' | string;
  type: 'lxc' | 'vm';
  tags?: string;
  lock?: string;
  uptime?: number;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  netinRate?: number | null;
  netoutRate?: number | null;
}

export interface Disk {
  devpath: string;
  model: string;
  serial: string;
  type: string;
  size: number;
  used: string;
  health: string;
  wearout: number | null;
  tempC: number | null;
  powerOnHours: number | null;
  reallocated: number | null;
}

export interface Share {
  name: string;
  path: string;
  dataset?: string | null;
  comment: string;
  readOnly: boolean;
  guestOk: boolean;
  browseable: boolean;
  inheritPermissions: boolean;
}

export interface SmbUser {
  username: string;
  fullName: string;
}

export interface HostHealth {
  hostname?: string;
  kernel?: string;
  pveVersion?: string;
  cpu: { pct: number; cores: number };
  mem: { totalBytes: number; usedBytes: number };
  swap: { totalBytes: number; usedBytes: number };
  load: { load1: number; load5: number; load15: number };
  uptimeSeconds: number;
  timestamp: string;
}

export interface GuestConfigEntry {
  label?: string; // the guest name this entry was written for; it's ignored if the VMID now has another name
  open?: string;
  dash?: string;
  links?: Array<{ label: string; url: string }>;
}

export interface GuestsConfig {
  defaults?: {
    lxc?: GuestConfigEntry;
    vm?: GuestConfigEntry;
  };
  guests?: Record<string, GuestConfigEntry>;
}

export interface ActivityEntry {
  id: number;
  timestamp: string;
  actor: string;
  action: string;
  target: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
}

export interface UpdatesInfo {
  count: number;
  patches: number;
  updates: number;
  upgrades: number;
  packages: Array<{ package: string; oldVersion: string; version: string; kind: string }>;
  checkedAt: string | null;
}

export interface CollectorStatus {
  intervalMs: number;
  lastRun: string | null;
  lastOk: string | null;
  ok: boolean | null;
  error: string | null;
  durationMs: number | null;
  via: string | null;
}

// Live hardware from the `hardware` collector (every 10 s). Rates are averaged over the
// interval between the last two samples; a slot is a part key in the machine model
// (client/src/viz/machine/types.ts).
export interface HardwareDisk {
  name: string;                 // sda, nvme1n1
  serial: string;
  kind: 'hdd' | 'nvme';
  port: string;                 // ata-3, or the NVMe controller's PCI address 0000:68:00.0
  slot: string | null;          // bay1..bay6, m2s1..m2s5
  slotSource: 'config' | 'assumed'; // assumed: from SATA port / PCI order, not confirmed in /etc/onas/hardware.json
  readBps: number;
  writeBps: number;
  readIops: number;
  writeIops: number;
  busyPct: number;              // share of the interval the device had I/O in flight, 0..100
  tempC: number | null;         // NVMe: hwmon, live. HDD: smartctl -n standby, every few minutes
  tempAt: string | null;        // when tempC was read
  standby: boolean | null;      // HDD spun down (temperature not read, to avoid waking it)
}

export interface HardwareNic {
  name: string;                 // enp101s0
  slot: string | null;          // lan1, lan2, sfp1, sfp2
  slotSource: 'config' | 'assumed';
  kind: '2.5GbE' | '10GbE SFP+' | string;
  up: boolean;                  // carrier
  speedMbps: number | null;
  rxBps: number;
  txBps: number;
}

export interface HardwareState {
  sampledAt: string;
  intervalS: number;
  cpu: { tempC: number | null };                       // k10temp Tctl
  memory: Array<{ slot: string; tempC: number | null }>; // spd5118, ram1/ram2
  disks: HardwareDisk[];
  nics: HardwareNic[];
}

// Where the host's CPU goes, from the `cpu` collector (every 10 s), in host cores. Guests,
// services and the kernel add up to busyCores; kernelThreads break the kernel row down.
export interface CpuConsumer {
  key: string;                  // guest-108, svc-pvestatd, user, kernel, k-arc_prune
  kind: 'guest' | 'service' | 'kernel' | 'kthread';
  ref: string | null;           // vmid, systemd unit, or kernel thread family
  name: string;
  cores: number;
}

export interface CpuState {
  sampledAt: string;
  intervalS: number;
  cores: number;
  busyCores: number;
  iowaitCores: number;          // idle waiting on disk, not part of busyCores
  consumers: CpuConsumer[];     // largest first
  kernelThreads: CpuConsumer[];
  arc: {
    sizeBytes: number;
    targetBytes: number;
    maxBytes: number;
    dnodeBytes: number;
    dnodeLimitBytes: number;    // past this, arc_prune spins evicting dnodes
    pruneRate: number | null;   // arc_prune calls per second
  } | null;
}

export interface CpuHistory {
  hours: number;
  step: number;
  start: number;
  end: number;
  series: Array<{ key: string; values: Array<number | null> }>; // key: consumer key, or 'busy'
}

export interface DashboardState {
  host: HostHealth | null;
  hardware: HardwareState | null;
  cpu: CpuState | null;
  guests: Guest[];
  pools: Pool[];
  datasets: Dataset[];
  mounts: GuestMount[];
  snapshots: Snapshot[];
  disks: Disk[];
  shares: Share[];
  smbUsers: SmbUser[];
  smbConnections: SmbConnection[];
  updates: UpdatesInfo;
  activity: ActivityEntry[];
  guestsConfig: GuestsConfig;
  collectors: Record<string, CollectorStatus>;
  timestamp: string;
}
