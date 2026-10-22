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

export interface DashboardState {
  host: HostHealth | null;
  guests: Guest[];
  pools: Pool[];
  datasets: Dataset[];
  snapshots: Snapshot[];
  disks: Disk[];
  shares: Share[];
  smbUsers: SmbUser[];
  updates: UpdatesInfo;
  activity: ActivityEntry[];
  guestsConfig: GuestsConfig;
  collectors: Record<string, CollectorStatus>;
  timestamp: string;
}
