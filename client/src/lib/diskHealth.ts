// How healthy is a disk, and where does it sit in its pool? Shared by the Storage and Machine
// views. Drives are matched three ways that all need to agree: Proxmox's SMART view (Disk),
// the pool's vdev tree (leaf names are /dev/disk/by-id paths containing the serial) and the
// hardware collector's slot map (HardwareDisk).
import type { DashboardState, Disk, HardwareDisk, Pool, Vdev } from './types';
import type { StatusLevel } from './palette';

export function diskLevel(d: Disk): { level: StatusLevel; note: string } {
  if (d.health !== 'PASSED' && d.health !== 'OK') return { level: 'critical', note: `SMART ${d.health}` };
  if ((d.reallocated ?? 0) > 0) return { level: 'serious', note: `${d.reallocated} reallocated sectors` };
  const hot = d.type === 'nvme' ? 70 : 50;
  if (d.tempC != null && d.tempC >= hot + 8) return { level: 'critical', note: `${d.tempC}°C` };
  if (d.tempC != null && d.tempC >= hot) return { level: 'warning', note: `${d.tempC}°C, running warm` };
  if (d.wearout != null && d.wearout < 20) return { level: 'warning', note: `${d.wearout}% life left` };
  return { level: 'good', note: 'healthy' };
}

export function diskFor(disks: Disk[], leaf: string): Disk | undefined {
  const id = leaf.replace(/-part\d+$/, '');
  return disks.find(d => d.devpath === id || (d.serial && id.includes(d.serial)) || id.endsWith(d.devpath.replace('/dev/', '')));
}

const RANK: Record<StatusLevel, number> = { good: 0, warning: 1, serious: 2, critical: 3 };

export function worseOf<T extends { level: StatusLevel }>(a: T, b: T): T {
  return RANK[b.level] > RANK[a.level] ? b : a;
}

// ---------- pool membership ----------

export interface PoolMember {
  pool: Pool;
  vdev: Vdev | null; // the raidz / mirror the disk sits in; null for a plain stripe
  leaf: Vdev;
}

export function leavesOf(pool: Pool): Array<{ vdev: Vdev | null; leaf: Vdev }> {
  const out: Array<{ vdev: Vdev | null; leaf: Vdev }> = [];
  for (const v of pool.vdevs) {
    if (v.leaf) out.push({ vdev: null, leaf: v });
    else for (const leaf of v.children ?? []) out.push({ vdev: v, leaf });
  }
  return out;
}

// The Proxmox disk entry for a hardware-collector disk: same serial, else same device name.
export function smartDiskFor(disks: Disk[], hw: HardwareDisk): Disk | undefined {
  return disks.find(d => hw.serial && d.serial === hw.serial) ?? disks.find(d => d.devpath === `/dev/${hw.name}`);
}

export function memberOf(state: DashboardState, hw: HardwareDisk): PoolMember | null {
  const smart = smartDiskFor(state.disks, hw);
  for (const pool of state.pools) {
    for (const { vdev, leaf } of leavesOf(pool)) {
      const id = leaf.name.replace(/-part\d+$/, '');
      const hit = (hw.serial && id.includes(hw.serial)) || id.endsWith(`/${hw.name}`) || id === hw.name || (smart ? diskFor([smart], leaf.name) !== undefined : false);
      if (hit) return { pool, vdev, leaf };
    }
  }
  return null;
}

// A leaf that is not ONLINE, or has counted errors, is a problem whatever SMART says.
export function leafProblem(leaf: Vdev): { level: StatusLevel; note: string } | null {
  const errors = leaf.read + leaf.write + leaf.cksum;
  const counts = [leaf.read && `${leaf.read} read`, leaf.write && `${leaf.write} write`, leaf.cksum && `${leaf.cksum} checksum`].filter(Boolean).join(', ');
  const errorText = `${counts} error${errors === 1 ? '' : 's'}`;
  if (leaf.state !== 'ONLINE') return { level: 'critical', note: `${leaf.state.toLowerCase()} in its pool${errors > 0 ? `, ${errorText}` : ''}` };
  if (errors > 0) return { level: 'warning', note: errorText };
  return null;
}

// SMART verdict and pool state as one status for the drive.
export function driveStatus(smart: Disk | undefined, member: PoolMember | null, liveTempC?: number | null): { level: StatusLevel; note: string } {
  let status: { level: StatusLevel; note: string } = { level: 'good', note: 'healthy' };
  if (smart) status = diskLevel(liveTempC != null ? { ...smart, tempC: Math.round(liveTempC) } : smart);
  const problem = member ? leafProblem(member.leaf) : null;
  if (problem) status = worseOf(status, problem);
  return status;
}

// ---------- slots ----------

// "bay3" -> "Bay 3", "m2s1" -> "M.2 1": how a slot is named wherever it is shown as text.
export function slotName(key: string): string {
  let m = /^bay(\d+)$/.exec(key);
  if (m) return `Bay ${m[1]}`;
  m = /^m2s(\d+)$/.exec(key);
  if (m) return `M.2 ${m[1]}`;
  m = /^lan(\d+)$/.exec(key);
  if (m) return `LAN ${m[1]}`;
  m = /^sfp(\d+)$/.exec(key);
  if (m) return `SFP+ ${m[1]}`;
  m = /^ram(\d+)$/.exec(key);
  if (m) return `DIMM ${m[1]}`;
  if (key === 'cpu') return 'CPU';
  return key;
}

// Drive capacity the way it is sold: decimal, rounded ("6 TB", "512 GB").
export function fmtDriveSize(bytes: number | null | undefined): string {
  if (!bytes) return '—';
  if (bytes >= 1e12) {
    const tb = bytes / 1e12;
    return `${tb >= 10 || Math.abs(tb - Math.round(tb)) < 0.06 ? Math.round(tb) : tb.toFixed(1)} TB`;
  }
  return `${Math.round(bytes / 1e9)} GB`;
}

// "WDC_WD60EFPX-68C5ZN0" -> "WDC WD60EFPX-68C5ZN0".
export function prettyModel(model: string): string {
  return model.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}
