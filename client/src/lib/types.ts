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
  status: string;
  type: 'lxc' | 'vm';
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
