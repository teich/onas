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
