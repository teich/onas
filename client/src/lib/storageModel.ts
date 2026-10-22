// Turns the raw state into the storage map's model: each pool's datasets (top level only;
// nested datasets roll up into their parent), and what uses them: SMB shares and guests'
// bind mounts. Guest root disks fold into one "guest disks" node per pool, and small datasets
// nothing uses fold into "other".
import type { DashboardState, Dataset, Guest, Pool, Share } from './types';

export const GUEST_DISK_RE = /\/(subvol|vm|base)-(\d+)-disk-\d+$/;
export const SELF_VMID = 119; // onas itself: its bind mounts are what the SMB shares use

export interface DatasetNode {
  id: string;
  pool: string;
  kind: 'root' | 'dataset' | 'guests' | 'other';
  label: string;
  bytes: number;
  members: string[]; // dataset names this node stands for
}

export interface PoolGroup {
  pool: Pool;
  nodes: DatasetNode[];
}

export interface Consumer {
  id: string;
  kind: 'share' | 'service';
  label: string;
  detail: string;
  activity: number; // 0..1, drives the flow animation
  share?: Share;
  guest?: Guest;
  connections: number;
}

export interface MapLink {
  from: string; // DatasetNode id
  to: string; // Consumer id
  pool: string;
  readOnly: boolean;
  path: string;
}

export interface StorageModel {
  groups: PoolGroup[];
  consumers: Consumer[];
  links: MapLink[];
  nodeOf: (dataset: string) => string | null;
}

export function poolOf(dataset: string): string {
  return dataset.split('/')[0];
}

export function topLevel(dataset: string): string {
  return dataset.split('/').slice(0, 2).join('/');
}

export function isGuestDisk(dataset: string): boolean {
  return GUEST_DISK_RE.test(dataset);
}

// Network rate (bytes/s) to a 0..1 activity level on a log scale: 1 KB/s is barely moving,
// 100 MB/s is flat out.
export function activityFromRate(rate: number): number {
  if (!rate || rate < 1024) return 0;
  return Math.min(1, Math.log10(rate / 1024) / 5);
}

export function buildStorageModel(state: DashboardState): StorageModel {
  const consumers: Consumer[] = [];
  const links: MapLink[] = [];
  const usedNodes = new Set<string>();

  // Which top-level dataset (or pool root) does a dataset belong to on the map?
  const rawNodeOf = (dataset: string): string => {
    if (!dataset.includes('/')) return `root:${dataset}`;
    if (isGuestDisk(dataset)) return `guests:${poolOf(dataset)}`;
    return `ds:${topLevel(dataset)}`;
  };

  for (const share of state.shares) {
    if (!share.dataset) continue;
    const conns = state.smbConnections.filter(c => c.share === share.name);
    const id = `share:${share.name}`;
    consumers.push({
      id,
      kind: 'share',
      label: share.name,
      detail: conns.length ? `${conns.length} connected` : share.readOnly ? 'read-only' : '',
      activity: conns.length ? Math.min(1, 0.35 + 0.15 * conns.length) : 0,
      share,
      connections: conns.length,
    });
    const from = rawNodeOf(share.dataset);
    usedNodes.add(from);
    links.push({ from, to: id, pool: poolOf(share.dataset), readOnly: share.readOnly, path: share.path });
  }

  const guestsById = new Map(state.guests.map(g => [g.vmid, g]));
  const binds = state.mounts.filter(m => m.kind === 'bind' && m.dataset && m.vmid !== SELF_VMID);
  for (const vmid of [...new Set(binds.map(m => m.vmid))]) {
    const guest = guestsById.get(vmid);
    const id = `guest:${vmid}`;
    const rate = (guest?.netinRate ?? 0) + (guest?.netoutRate ?? 0);
    consumers.push({
      id,
      kind: 'service',
      label: guest?.name ?? `guest ${vmid}`,
      detail: `${guest?.type === 'vm' ? 'VM' : 'LXC'} ${vmid}${guest && guest.status !== 'running' ? ` · ${guest.status}` : ''}`,
      activity: guest?.status === 'running' ? activityFromRate(rate) : 0,
      guest,
      connections: 0,
    });
    for (const m of binds.filter(b => b.vmid === vmid)) {
      const from = rawNodeOf(m.dataset!);
      usedNodes.add(from);
      links.push({ from, to: id, pool: poolOf(m.dataset!), readOnly: m.readOnly, path: `${m.source} → ${m.target}` });
    }
  }

  const groups: PoolGroup[] = state.pools.map(pool => {
    const all = state.datasets.filter(d => poolOf(d.name) === pool.name && d.name !== pool.name);
    const nodes: DatasetNode[] = [];
    const tops = new Map<string, Dataset>();
    const guestDisks: Dataset[] = [];
    for (const d of all) {
      if (isGuestDisk(d.name)) guestDisks.push(d);
      else if (d.name.split('/').length === 2) tops.set(d.name, d);
    }
    const threshold = pool.alloc * 0.004;
    const other: Dataset[] = [];
    for (const d of [...tops.values()].sort((a, b) => b.used - a.used)) {
      const id = `ds:${d.name}`;
      if (d.used < threshold && !usedNodes.has(id)) { other.push(d); continue; }
      nodes.push({ id, pool: pool.name, kind: 'dataset', label: d.name.split('/')[1], bytes: d.used, members: [d.name] });
    }
    if (guestDisks.length) {
      nodes.push({
        id: `guests:${pool.name}`,
        pool: pool.name,
        kind: 'guests',
        label: `guest disks (${guestDisks.length})`,
        bytes: guestDisks.reduce((s, d) => s + d.used, 0),
        members: guestDisks.map(d => d.name),
      });
    }
    if (other.length) {
      nodes.push({
        id: `other:${pool.name}`,
        pool: pool.name,
        kind: 'other',
        label: other.length === 1 ? other[0].name.split('/')[1] : `${other.length} small datasets`,
        bytes: other.reduce((s, d) => s + d.used, 0),
        members: other.map(d => d.name),
      });
    }
    // Something mounts the whole pool: give it a node at the top so its links have a source.
    if (usedNodes.has(`root:${pool.name}`)) {
      nodes.unshift({ id: `root:${pool.name}`, pool: pool.name, kind: 'root', label: `whole pool`, bytes: 0, members: [pool.name] });
    }
    return { pool, nodes };
  });

  // Links into folded nodes point at the fold.
  const nodeIds = new Set(groups.flatMap(g => g.nodes.map(n => n.id)));
  const memberIndex = new Map<string, string>();
  for (const g of groups) for (const n of g.nodes) for (const m of n.members) memberIndex.set(m, n.id);
  const nodeOf = (dataset: string): string | null => {
    const raw = rawNodeOf(dataset);
    if (nodeIds.has(raw)) return raw;
    return memberIndex.get(topLevel(dataset)) ?? memberIndex.get(dataset) ?? null;
  };
  for (const link of links) {
    if (!nodeIds.has(link.from)) link.from = memberIndex.get(link.from.replace(/^ds:/, '')) ?? link.from;
  }

  return { groups, consumers, links: links.filter(l => nodeIds.has(l.from)), nodeOf };
}

export function datasetByName(state: DashboardState, name: string): Dataset | undefined {
  return state.datasets.find(d => d.name === name);
}
