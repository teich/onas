export interface Vdev {
  name: string;
  state: string;
  read: number;
  write: number;
  cksum: number;
  children: Vdev[];
  _indent?: number;
}

export interface Pool {
  name: string;
  size: string;
  alloc: string;
  free: string;
  frag: string;
  cap: number;
  dedup: string;
  health: string;
  scan?: string;
  errors?: string;
  vdevs?: Vdev[];
  configRaw?: string;
}

export interface Dataset {
  name: string;
  used: string;
  avail: string;
  refer: string;
  mountpoint: string;
  type: string;
  volsize: string | null;
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
  uptime?: number;
  cpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  netin?: number;
  netout?: number;
  diskread?: number;
  diskwrite?: number;
  lock?: string;
  ip?: string;
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
  flags: string;
}

export interface HostHealth {
  hostname?: string;
  kernel?: string;
  cpu: { pct: number; cores: number };
  mem: { totalBytes: number; usedBytes: number; availBytes: number };
  swap: { totalBytes: number; usedBytes: number };
  load: { load1: number; load5: number; load15: number };
  uptimeSeconds: number;
  timestamp: string;
}

export interface SmartDisk {
  device: string;
  model: string;
  serial: string;
  type: 'ata' | 'nvme' | 'unknown';
  tempC: number | null;
  healthPassed: boolean | null;
  smartStatus: string;
  powerOnHours: number | null;
  reallocatedSectors: number | null;
  error?: string;
}

export interface GuestConfigEntry {
  label?: string;
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
  id: string;
  timestamp: string;
  action: string;
  target: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface UpdatesInfo {
  count: number;
  patches?: number;
  updates?: number;
  upgrades?: number;
  packages: string[];
  raw: string;
  checkedAt: string | null;
  stale?: boolean;
}

export interface DashboardState {
  host: HostHealth | null;
  guests: Guest[];
  pools: Pool[];
  datasets: Dataset[];
  snapshots: Snapshot[];
  shares: Share[];
  updates: UpdatesInfo;
  activity: ActivityEntry[];
  guestsConfig: GuestsConfig;
  timestamp: string;
}
