// Live state -> what the Machine scene shows. Pure: no React state, no fetching.
//
//   buildSlots(state, model, now)      one record per physical slot (bays, M.2, NIC ports, CPU, DIMMs)
//   lensScene(state, model, lens, selected, hovered, now)
//                                      per-part visuals, flows and labels for one lens
//
// The rule the three lenses share: colour is the lens, motion is live activity. Whatever the
// colour means, a busy drive twinkles and a quiet one doesn't.
import { createElement as h, type ReactNode } from 'react';
import type { DashboardState, Disk, HardwareDisk, HardwareNic } from './types';
import type { Flow, MachineModel, PartVisual, SceneLabel, Vec3 } from '../viz/machine/types';
import { hex } from './gpu';
import { heatRgb, poolColor, STATUS, type StatusLevel } from './palette';
import { SELF_VMID, poolOf } from './storageModel';
import { driveStatus, fmtDriveSize, memberOf, slotName, smartDiskFor, worseOf, type PoolMember } from './diskHealth';
import { fmtRate } from './format';

export type Lens = 'drives' | 'heat' | 'traffic';
export const LENSES: Array<{ id: Lens; label: string }> = [
  { id: 'drives', label: 'Drives' },
  { id: 'heat', label: 'Heat' },
  { id: 'traffic', label: 'Traffic' },
];

export type SlotKind = 'hdd' | 'nvme' | 'nic' | 'cpu' | 'ram';
export type SlotGroup = 'bays' | 'm2' | 'other' | 'net' | 'host';
export type HardwareStatus = 'ok' | 'stale' | 'waiting';

export const HW_STALE_MS = 60_000;

// ---------- colours ----------

export const PORCELAIN: Vec3 = hex('#f0efec');
export const TOWARD_CPU: Vec3 = hex('#9fd8ff'); // disk reads, network rx
export const AWAY_FROM_CPU: Vec3 = hex('#ffd59a'); // disk writes, network tx
export const TOWARD_CPU_CSS = '#9fd8ff';
export const AWAY_FROM_CPU_CSS = '#ffd59a';

// Each kind of part is measured against its own limit: [cool, limit] in °C.
export const HEAT_RANGE: Record<'hdd' | 'nvme' | 'cpu' | 'ram', [number, number]> = {
  hdd: [25, 55],
  nvme: [30, 80],
  cpu: [40, 95],
  ram: [30, 85],
};

export function heatT(kind: SlotKind, tempC: number | null): number | null {
  if (tempC == null || kind === 'nic') return null;
  const [cool, limit] = HEAT_RANGE[kind];
  return Math.min(1, Math.max(0, (tempC - cool) / (limit - cool)));
}

// ---------- hardware freshness ----------

export function hardwareStatus(state: DashboardState, now: number): HardwareStatus {
  const hw = state.hardware;
  if (!hw) return 'waiting';
  const at = Date.parse(hw.sampledAt);
  return Number.isFinite(at) && now - at > HW_STALE_MS ? 'stale' : 'ok';
}

// ---------- throughput scale ----------

export const FLOW_FLOOR_BPS = 50_000; // under this a device counts as idle: no flow, no label
export const FULL_BPS = { hdd: 250e6, nvme: 3e9 };

// bytes/s -> 0..1 on a log scale between "barely moving" (50 KB/s) and the device's full speed.
// Anything over the floor shows at 0.1 at least, so a trickle is visible but clearly small.
export function rateLevel(bps: number, full: number): number {
  if (!(bps >= FLOW_FLOOR_BPS)) return 0;
  const lo = Math.log10(FLOW_FLOOR_BPS);
  const hi = Math.log10(Math.max(full, FLOW_FLOOR_BPS * 10));
  return Math.min(1, 0.1 + (0.9 * (Math.log10(bps) - lo)) / (hi - lo));
}

// ---------- slots ----------

export interface Slot {
  key: string;
  name: string;               // "Bay 3"
  kind: SlotKind;
  group: SlotGroup;
  empty: boolean;
  live: boolean;              // false when the hardware data is stale: rates are zeroed
  disk: HardwareDisk | null;
  smart: Disk | undefined;
  member: PoolMember | null;
  pool: string | null;        // a drive's ZFS pool; null for a disk in no pool or a non-drive
  nic: HardwareNic | null;
  tempC: number | null;
  tempStale: boolean;         // a last-known value (drive asleep, reading old, hardware data stale): shown muted, never coloured as current
  tempNote: string;           // why, e.g. "asleep, read 3 h ago"
  level: StatusLevel;
  note: string;               // why, when level is not good
  readBps: number;            // NIC: rx
  writeBps: number;           // NIC: tx
  activity: number;           // 0..1 for the scene's twinkle
  fullBps: number;            // this device's top throughput, for the log scale
  onasPool: string | null;    // set when onas's own rootfs lives on this drive's pool
}

// A temperature older than this is last-known. HDDs are read every few minutes while spinning.
const TEMP_STALE_MS = 15 * 60_000;

function agoText(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 60 * 24) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 60 / 24)} d ago`;
}

const DEFAULT_BAYS = ['bay1', 'bay2', 'bay3', 'bay4', 'bay5', 'bay6'];
const DEFAULT_M2 = ['m2s1', 'm2s2', 'm2s3', 'm2s4', 'm2s5'];
const DEFAULT_NET = ['lan1', 'lan2', 'sfp1', 'sfp2'];
const DEFAULT_RAM = ['ram1', 'ram2'];

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

// The pool onas's own container keeps its root filesystem on ("you are here").
export function selfPlacement(state: DashboardState): { pool: string; dataset: string } | null {
  const m = state.mounts.find(x => x.vmid === SELF_VMID && x.kind === 'rootfs' && x.dataset);
  return m ? { pool: poolOf(m.dataset!), dataset: m.dataset! } : null;
}

export function buildSlots(state: DashboardState, model: MachineModel | null, now: number): Slot[] {
  const hw = state.hardware;
  const live = hardwareStatus(state, now) === 'ok';
  const have = (k: string) => (model ? model.byKey.has(k) : true);
  // One device per slot: if two claim the same one (a typo in /etc/onas/hardware.json) the first
  // keeps it and the other is listed apart with the conflict named.
  const hwDisks = new Map<string, HardwareDisk>();
  const hwNics = new Map<string, HardwareNic>();
  const clashDisks: Array<{ d: HardwareDisk; note: string }> = [];
  const clashNics: Array<{ n: HardwareNic; note: string }> = [];
  for (const d of hw?.disks ?? []) {
    if (!d.slot) continue;
    const first = hwDisks.get(d.slot);
    if (first) clashDisks.push({ d, note: `also mapped to ${slotName(d.slot)}, which ${first.name} already holds` });
    else hwDisks.set(d.slot, d);
  }
  for (const n of hw?.nics ?? []) {
    if (!n.slot) continue;
    const first = hwNics.get(n.slot);
    if (first) clashNics.push({ n, note: `also mapped to ${slotName(n.slot)}, which ${first.name} already holds` });
    else hwNics.set(n.slot, n);
  }
  const self = selfPlacement(state);

  const keys = (defaults: string[], extra: Iterable<string>, re: RegExp) =>
    [...new Set([...defaults.filter(have), ...[...extra].filter(k => re.test(k))])].sort(natural);
  const bays = keys(DEFAULT_BAYS, hwDisks.keys(), /^bay\d+$/);
  const m2 = keys(DEFAULT_M2, hwDisks.keys(), /^m2s\d+$/);
  const net = [...new Set([...DEFAULT_NET.filter(have), ...[...hwNics.keys()]])].sort(natural);
  const ram = keys(DEFAULT_RAM, (hw?.memory ?? []).map(m => m.slot), /^ram\d+$/);

  const out: Slot[] = [];
  const base = (key: string, kind: SlotKind, group: SlotGroup): Slot => ({
    key, name: slotName(key), kind, group, empty: false, live, disk: null, smart: undefined, member: null, pool: null, nic: null,
    tempC: null, tempStale: false, tempNote: '', level: 'good', note: '', readBps: 0, writeBps: 0, activity: 0, fullBps: 0, onasPool: null,
  });

  const drive = (key: string, kind: 'hdd' | 'nvme', group: SlotGroup, placed?: HardwareDisk, conflict?: string) => {
    const s = base(key, kind, group);
    const d = placed ?? hwDisks.get(key) ?? null;
    if (placed) s.name = placed.name;
    s.fullBps = FULL_BPS[kind];
    if (!d) { s.empty = true; return s; }
    s.disk = d;
    s.kind = d.kind;
    s.fullBps = FULL_BPS[d.kind];
    s.smart = smartDiskFor(state.disks, d);
    s.member = memberOf(state, d);
    s.pool = s.member?.pool.name ?? null;
    s.tempC = d.tempC ?? s.smart?.tempC ?? null;
    const age = d.tempAt ? now - Date.parse(d.tempAt) : null;
    const old = age != null && age > TEMP_STALE_MS;
    s.tempStale = s.tempC != null && (!live || d.standby === true || d.tempC == null || old || (d.kind === 'hdd' && age == null));
    if (s.tempStale) {
      s.tempNote = d.standby ? `asleep${age != null ? `, read ${agoText(age)}` : ''}`
        : d.tempC == null ? 'from the last SMART scan'
        : old ? `read ${agoText(age!)}`
        : 'hardware data stale';
    }
    // Only a current temperature can raise a temperature warning.
    let status = driveStatus(s.tempStale && s.smart ? { ...s.smart, tempC: null } : s.smart, s.member, s.tempStale ? null : d.tempC);
    if (conflict) status = worseOf(status, { level: 'warning' as StatusLevel, note: conflict });
    s.level = status.level;
    s.note = status.level === 'good' ? '' : status.note;
    if (live) {
      s.readBps = d.readBps;
      s.writeBps = d.writeBps;
      s.activity = Math.sqrt(Math.min(1, Math.max(0, d.busyPct / 100)));
    }
    s.onasPool = self && s.pool === self.pool ? self.pool : null;
    return s;
  };

  for (const key of bays) out.push(drive(key, 'hdd', 'bays'));
  for (const key of m2) out.push(drive(key, 'nvme', 'm2'));
  // A disk the collector can't place in any slot still belongs on the list.
  for (const d of hw?.disks ?? []) if (!d.slot) out.push(drive(`disk:${d.name}`, d.kind, 'other', d));
  for (const { d, note } of clashDisks) out.push(drive(`disk:${d.name}`, d.kind, 'other', d, note));

  for (const key of net) {
    const s = base(key, 'nic', 'net');
    const n = hwNics.get(key) ?? null;
    s.nic = n;
    s.fullBps = n?.speedMbps ? (n.speedMbps * 1e6) / 8 : 0;
    if (n && live && n.up) {
      s.readBps = n.rxBps;
      s.writeBps = n.txBps;
      s.activity = rateLevel(Math.max(n.rxBps, n.txBps), s.fullBps);
    }
    out.push(s);
  }
  for (const { n, note } of clashNics) {
    const s = base(`nic:${n.name}`, 'nic', 'net');
    s.name = n.name;
    s.nic = n;
    s.fullBps = n.speedMbps ? (n.speedMbps * 1e6) / 8 : 0;
    s.level = 'warning';
    s.note = note;
    out.push(s);
  }

  const cpu = base('cpu', 'cpu', 'host');
  cpu.tempC = hw?.cpu.tempC ?? null;
  cpu.tempStale = cpu.tempC != null && !live;
  if (cpu.tempStale) cpu.tempNote = 'hardware data stale';
  else if (cpu.tempC != null && cpu.tempC >= 95) { cpu.level = 'critical'; cpu.note = `${Math.round(cpu.tempC)}°C, at its limit`; }
  else if (cpu.tempC != null && cpu.tempC >= 90) { cpu.level = 'warning'; cpu.note = `${Math.round(cpu.tempC)}°C, running hot`; }
  if (live && state.host) cpu.activity = Math.sqrt(Math.min(1, Math.max(0, state.host.cpu.pct / 100)));
  out.push(cpu);

  for (const key of ram) {
    const s = base(key, 'ram', 'host');
    s.tempC = hw?.memory.find(m => m.slot === key)?.tempC ?? null;
    s.tempStale = s.tempC != null && !live;
    if (s.tempStale) s.tempNote = 'hardware data stale';
    else if (s.tempC != null && s.tempC >= 85) { s.level = 'critical'; s.note = `${Math.round(s.tempC)}°C, at its limit`; }
    else if (s.tempC != null && s.tempC >= 78) { s.level = 'warning'; s.note = `${Math.round(s.tempC)}°C, running hot`; }
    out.push(s);
  }
  return out;
}

// "6 × 6 TB raidz2 (bulk)": one segment per top-level vdev, from live state.
export function poolSummary(state: DashboardState): string[] {
  const out: string[] = [];
  for (const pool of state.pools) {
    const groups = pool.vdevs.length && pool.vdevs.every(v => v.leaf)
      ? [{ type: 'stripe', leaves: pool.vdevs }]
      : pool.vdevs.map(v => ({ type: v.name.replace(/-\d+$/, ''), leaves: v.children ?? [] }));
    for (const g of groups) {
      const size = g.leaves.length ? state.disks.find(d => d.serial && g.leaves[0].name.includes(d.serial))?.size : undefined;
      out.push(`${g.leaves.length} × ${size ? `${fmtDriveSize(size)} ` : ''}${g.type} (${pool.name})`);
    }
  }
  return out;
}

// ---------- the scene ----------

export interface LensScene {
  visuals: Record<string, PartVisual>;
  defaultVisual: PartVisual;
  flows: Flow[];
  labels: SceneLabel[];
  xray: number;
}

const visual = (color: Vec3, intensity: number, activity = 0, pulse = 0): PartVisual => ({ color, intensity, activity, pulse, slide: 0 });

// Colour and pulse for a health problem: warning amber breathing gently, critical red hard.
function alertLook(level: StatusLevel): { color: Vec3; pulse: number } | null {
  if (level === 'warning') return { color: hex(STATUS.warning), pulse: 0.4 };
  if (level === 'serious') return { color: hex(STATUS.serious), pulse: 0.55 };
  if (level === 'critical') return { color: hex(STATUS.critical), pulse: 1 };
  return null;
}

function slotVisual(lens: Lens, s: Slot): PartVisual | null {
  const alert = alertLook(s.level);
  const pulse = alert?.pulse ?? 0;

  if (lens === 'drives') {
    if (s.kind === 'nic') return visual(PORCELAIN, s.nic?.up ? 1 : 0.3, s.activity);
    if (s.kind === 'cpu' || s.kind === 'ram') return null;
    if (s.empty) return visual(PORCELAIN, 0.3);
    const color = alert?.color ?? (s.pool ? hex(poolColor(s.pool)) : PORCELAIN);
    return visual(color, 1, s.activity, pulse);
  }

  if (lens === 'heat') {
    const t = heatT(s.kind, s.tempStale ? null : s.tempC);
    if (t == null) return pulse ? visual(PORCELAIN, 0.3, s.activity, pulse) : null;
    return visual(heatRgb(t), 0.85 + 0.45 * t, s.activity, pulse);
  }

  // traffic: the streams carry the direction in colour, so the parts stay quiet and neutral and
  // only brighten with their own throughput. Tinting them as well turns a busy machine into a haze.
  if (s.kind === 'cpu') return visual(PORCELAIN, 0.35 + 0.3 * s.activity, s.activity, pulse);
  if (s.kind === 'ram') return null;
  if (s.empty || (s.kind === 'nic' && !s.nic?.up)) return visual(PORCELAIN, s.empty ? 0.12 : 0.2);
  const level = rateLevel(Math.max(s.readBps, s.writeBps), s.fullBps);
  return visual(PORCELAIN, 0.28 + 0.42 * level, s.activity, pulse);
}

// ---- labels ----

type Tone = NonNullable<SceneLabel['tone']>;
const TONE: Record<StatusLevel, Tone> = { good: 'default', warning: 'warning', serious: 'warning', critical: 'critical' };

const rate = (bps: number) => (bps >= FLOW_FLOOR_BPS ? fmtRate(bps) : null);
const deg = (t: number | null) => (t == null ? null : `${Math.round(t)}°C`);

function trafficText(s: Slot): string | null {
  const [a, b] = s.kind === 'nic' ? ['rx', 'tx'] : ['R', 'W'];
  const parts = [rate(s.readBps) && `${a} ${rate(s.readBps)}`, rate(s.writeBps) && `${b} ${rate(s.writeBps)}`].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

// Busy enough to be named in the Traffic lens: R + W of at least 1 MB/s. Used by the per-part
// labels and the bay summary alike, so the two never disagree.
const moving = (s: Slot) => s.readBps + s.writeBps >= 1e6;

// What the lens prints beside a part without being asked (HDDs: see bayLabels). A last-known
// temperature is not printed as if it were current.
function ambientText(lens: Lens, s: Slot): string | null {
  if (lens === 'heat') return s.kind === 'nic' || s.tempStale ? null : deg(s.tempC);
  if (lens === 'traffic') {
    if (s.empty) return null;
    if (s.kind === 'nic') return s.nic?.up ? trafficText(s) ?? 'idle' : null;
    if (s.kind === 'cpu' || s.kind === 'ram') return null;
    return moving(s) ? trafficText(s) : null;
  }
  return null;
}

// "1.4–1.6 MB/s": one unit when both ends share it.
function rateRange(lo: number, hi: number): string {
  const a = fmtRate(lo), b = fmtRate(hi);
  if (a === b) return a;
  const unit = (t: string) => t.slice(t.indexOf(' '));
  return unit(a) === unit(b) ? `${a.slice(0, a.indexOf(' '))}–${b}` : `${a}–${b}`;
}

// Six bays at 32-33 °C don't need six labels sitting shoulder to shoulder on the lid. Bays
// that look like the rest share one label (on the middle one); the odd ones out, and any that
// have a problem, keep their own.
function bayLabels(lens: Lens, slots: Slot[], focus: Array<string | null>): Map<string, { name: string | null; text: string }> {
  const out = new Map<string, { name: string | null; text: string }>();
  if (lens === 'drives') return out;
  const value = (s: Slot) => (lens === 'heat' ? (s.tempStale ? null : s.tempC) : moving(s) ? s.readBps + s.writeBps : null);
  const bays = slots.filter(s => s.kind === 'hdd' && !s.empty && value(s) != null);
  if (!bays.length) return out;
  const sorted = bays.map(s => value(s)!).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const likeRest = (s: Slot) => s.level === 'good' && (lens === 'heat' ? Math.abs(value(s)! - median) <= 3 : value(s)! <= median * 2 && value(s)! >= median / 2);
  const rest = bays.filter(likeRest);
  const odd = bays.filter(s => !likeRest(s));
  for (const s of odd) out.set(s.key, { name: s.name, text: ambientText(lens, s) ?? '' });
  if (rest.length === 1) out.set(rest[0].key, { name: rest[0].name, text: ambientText(lens, rest[0]) ?? '' });
  else if (rest.length > 1) {
    const vals = rest.map(value as (s: Slot) => number);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const text = lens === 'heat'
      ? (Math.round(lo) === Math.round(hi) ? `${Math.round(lo)}°C` : `${Math.round(lo)}–${Math.round(hi)}°C`)
      : `${rateRange(lo, hi)} each`;
    // Anchored on the middle bay, unless that one is being pointed at and already has its own label.
    const free = rest.filter(s => !focus.includes(s.key));
    if (free.length) out.set(free[Math.floor((free.length - 1) / 2)].key, { name: odd.length ? 'Other bays' : 'Bays', text });
  }
  return out;
}

// What the lens prints when you point at a part: always something, even for an empty slot.
function focusText(lens: Lens, s: Slot): string {
  if (lens === 'heat') {
    if (s.kind === 'nic') return 'no temperature sensor';
    if (s.empty) return 'empty';
    if (s.tempC == null) return 'no temperature reading';
    return s.tempStale ? `${deg(s.tempC)} (${s.tempNote})` : deg(s.tempC)!;
  }
  if (lens === 'traffic') {
    if (s.empty) return 'empty';
    if (s.kind === 'cpu' || s.kind === 'ram') return deg(s.tempC) ?? '';
    if (s.kind === 'nic' && !s.nic?.up) return 'no link';
    return trafficText(s) ?? 'idle';
  }
  if (s.empty) return 'empty';
  if (s.kind === 'nic') return s.nic?.up ? `link up${s.nic.speedMbps ? ` · ${s.nic.speedMbps >= 1000 ? `${s.nic.speedMbps / 1000} Gb/s` : `${s.nic.speedMbps} Mb/s`}` : ''}` : 'no link';
  if (s.kind === 'cpu' || s.kind === 'ram') return deg(s.tempC) ?? '';
  const where = s.pool ?? (s.smart?.used && /BIOS|EFI|LVM|boot/i.test(s.smart.used) ? 'system disk' : 'not in a pool');
  return `${where} · ${fmtDriveSize(s.smart?.size)}`;
}

function labelNode(name: string | null, bits: string[]): ReactNode {
  return h('span', null, name ? h('b', null, name) : null, name && bits.length ? ' · ' : null, bits.join(' · '));
}

// ---- flows ----

// A stream's density, 0..1. rateLevel's log scale, with sub-1 MB/s traffic faded further: full
// strength from 1 MB/s up, about a fifth of it at 100 KB/s, so a trickle never reads as load.
export function flowRate(bps: number, full: number): number {
  const base = rateLevel(bps, full);
  if (base === 0) return 0;
  const t = Math.min(1, Math.max(0, Math.log10(bps / 1e5))); // 0 at 100 KB/s, 1 at 1 MB/s
  // Squared, so a busy stream stands well clear of background chatter beside it: on an HDD,
  // 1 MB/s draws at ~0.2 and 170 MB/s at ~0.9 (the plain log scale put them at 0.44 and 0.96).
  return base * base * (0.2 + 0.8 * t * t);
}

// The streams are a tree, like a river network, drawn once for each direction:
//
//   bayN --> sata --> bus --> cpu       reads / rx, toward the CPU (cool); writes / tx run the mirror
//   m2sX ---------^
//   port --> nicbus -------------> cpu
//
// Each device has a spur at its own rate; a trunk carries the sum of what feeds it, so the busy
// drive's stream continues down the trunk while the idle ones stay faint beside it. Anchors the
// model lacks are skipped (a model without 'sata' joins the bus directly).
function flowsFor(slots: Slot[], model: MachineModel): Flow[] {
  const exists = (n: string) => model.byKey.has(n) || n in model.manifest.anchors;
  const chain = (...names: string[]) => [...names.filter(exists), 'cpu'];
  const chains = { hdd: chain('sata', 'bus'), nvme: chain('bus'), nic: chain('nicbus') };
  const DIRS = [
    { id: 'in', bps: (s: Slot) => s.readBps, color: TOWARD_CPU },
    { id: 'out', bps: (s: Slot) => s.writeBps, color: AWAY_FROM_CPU },
  ] as const;
  type Dir = (typeof DIRS)[number]['id'];

  interface Trunk { a: string; b: string; capacity: number; sum: Record<Dir, number>; rate: Record<Dir, number>; upstream: Set<string> }
  const trunks = new Map<string, Trunk>();
  const spurs: Flow[] = [];

  for (const s of slots) {
    if (!model.byKey.has(s.key) || s.empty) continue;
    if (s.kind === 'cpu' || s.kind === 'ram') continue;
    if (s.kind === 'nic' && !s.nic?.up) continue;
    const path = chains[s.kind === 'hdd' ? 'hdd' : s.kind === 'nvme' ? 'nvme' : 'nic'];
    const edges = path.slice(0, -1).map((a, i) => `${a}>${path[i + 1]}`);
    edges.forEach((key, i) => {
      let t = trunks.get(key);
      if (!t) trunks.set(key, t = { a: path[i], b: path[i + 1], capacity: 0, sum: { in: 0, out: 0 }, rate: { in: 0, out: 0 }, upstream: new Set() });
      t.capacity += s.fullBps;   // what the trunk could carry: every device on it flat out
      if (i > 0) t.upstream.add(edges[i - 1]);
    });
    for (const d of DIRS) {
      const bps = d.bps(s);
      const rate = flowRate(bps, s.fullBps);
      if (rate === 0) continue;
      spurs.push(d.id === 'in'
        ? { id: `${s.key}:in`, from: s.key, via: [], to: path[0], rate, color: d.color }
        : { id: `${s.key}:out`, from: path[0], via: [], to: s.key, rate, color: d.color });
      for (const key of edges) {
        const t = trunks.get(key)!;
        t.sum[d.id] += bps;
        t.rate[d.id] = Math.max(t.rate[d.id], rate);   // a trunk is never fainter than a spur feeding it
      }
    }
  }

  const out: Flow[] = [];
  for (const d of DIRS) {
    for (const t of trunks.values()) t.rate[d.id] = Math.max(t.rate[d.id], flowRate(t.sum[d.id], t.capacity));
    for (let pass = 0; pass < 3; pass++) {   // ...nor fainter than the trunk upstream of it
      for (const t of trunks.values()) for (const up of t.upstream) t.rate[d.id] = Math.max(t.rate[d.id], trunks.get(up)!.rate[d.id]);
    }
  }
  const trunkFlows: Flow[] = [];
  for (const d of DIRS) {
    for (const [key, t] of trunks) {
      if (t.sum[d.id] === 0 || t.rate[d.id] === 0) continue;
      trunkFlows.push(d.id === 'in'
        ? { id: `trunk:${key}:in`, from: t.a, via: [], to: t.b, rate: t.rate[d.id], color: d.color }
        : { id: `trunk:${key}:out`, from: t.b, via: [], to: t.a, rate: t.rate[d.id], color: d.color });
    }
  }
  // The engine draws at most 16 streams. Trunks first (they carry the picture), then the strongest spurs.
  const byRate = (a: Flow, b: Flow) => b.rate - a.rate;
  out.push(...trunkFlows.sort(byRate), ...spurs.sort(byRate));
  return out.slice(0, 16);
}

// ---- interior parts ----

// Parts with at least one point on the outside of the closed case. The rest are only seen
// through the shell, so selecting one needs the x-ray.
const exteriorCache = new WeakMap<MachineModel, Set<string>>();
function exteriorParts(model: MachineModel): Set<string> | null {
  let set = exteriorCache.get(model);
  if (!set) {
    const ids = new Set<number>();
    const { points, flags } = model;
    for (let i = 0; i < flags.length; i++) if (flags[i] & 1) ids.add(points[i * 8 + 3]);
    set = new Set(model.parts.filter(p => ids.has(p.id)).map(p => p.key));
    exteriorCache.set(model, set);
  }
  return set.size ? set : null; // a model with no exterior flags at all: treat everything as visible
}

// ---------- the one function ----------

const BODY_DRIVES = visual(PORCELAIN, 1);
const BODY_HEAT = visual(PORCELAIN, 0.3);
const BODY_TRAFFIC = visual(PORCELAIN, 0.25);
const XRAY: Record<Lens, number> = { drives: 0, heat: 0.55, traffic: 0.6 };

export function lensScene(
  state: DashboardState,
  model: MachineModel,
  lens: Lens,
  selected: string | null,
  hovered: string | null,
  now: number,
  slots: Slot[] = buildSlots(state, model, now),
): LensScene {
  const status = hardwareStatus(state, now);
  const defaultVisual = lens === 'drives' ? BODY_DRIVES : lens === 'heat' ? BODY_HEAT : BODY_TRAFFIC;
  const byKey = new Map(slots.map(s => [s.key, s]));

  const visuals: Record<string, PartVisual> = {};
  if (status !== 'waiting') {
    for (const s of slots) {
      const v = slotVisual(lens, s);
      if (v) visuals[s.key] = v;
    }
  }

  // The M.2 sled hides its sticks behind the front panel, so it wears their colour: the pool most
  // of them belong to, pulsing if any of them has a problem, twinkling with the busiest.
  const sled = model.byKey.get('m2sled');
  if (lens === 'drives' && sled && status !== 'waiting') {
    const sticks = slots.filter(s => s.kind === 'nvme' && !s.empty && model.byKey.get(s.key)?.location === 'sled');
    if (sticks.length) {
      const counts = new Map<string, number>();
      for (const s of sticks) if (s.pool) counts.set(s.pool, (counts.get(s.pool) ?? 0) + 1);
      const pool = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const worst = sticks.reduce((a, b) => worseOf(a, b));
      const alert = alertLook(worst.level);
      visuals[sled.key] = visual(alert?.color ?? (pool ? hex(poolColor(pool)) : PORCELAIN), 1, Math.max(...sticks.map(s => s.activity)), alert?.pulse ?? 0);
    }
  }

  // The tray you're looking at slides out. A stick on the front sled brings the whole sled with it.
  const slide = (key: string) => {
    const part = model.byKey.get(key);
    if (part?.slide) visuals[key] = { ...(visuals[key] ?? defaultVisual), slide: 1 };
  };
  if (selected) {
    const part = model.byKey.get(selected);
    slide(selected);
    if (part && (part.kind === 'sled' || (part.kind === 'nvme' && part.location !== 'board'))) {
      slide('m2sled');
      for (const p of model.parts) if (p.location === 'sled') slide(p.key);
    }
  }

  // Labels: one per part. Alerts always, "onas runs here" in the Drives lens, whatever the lens
  // prints on its own, and the hovered / selected parts.
  const selfSlot = lens === 'drives' ? slots.find(s => s.onasPool) : undefined;
  const bayText = bayLabels(lens, slots, [hovered, selected]);
  const labels: SceneLabel[] = [];
  const labelled = new Set<string>();
  for (const s of slots) {
    if (!model.byKey.has(s.key) || status === 'waiting') continue;
    const focus = s.key === hovered || s.key === selected;
    const alert = s.level !== 'good';
    const self = s === selfSlot;
    const ambient = s.kind === 'hdd' ? bayText.get(s.key) : ((t: string | null) => (t == null ? undefined : { name: undefined, text: t }))(ambientText(lens, s));
    if (!focus && !alert && !self && !ambient) continue;
    const bits: string[] = [];
    const value = focus ? focusText(lens, s) : ambient?.text;
    // "74°C" and then "74°C, running warm" says it twice.
    if (value && !(alert && s.note.startsWith(value))) bits.push(value);
    if (alert) bits.push(s.note);
    if (self) bits.push('onas runs here');
    const plain = !focus && !alert && !self;
    const name = plain && ambient && ambient.name !== undefined ? ambient.name : s.name;
    labels.push({
      key: s.key,
      at: s.kind === 'nic' ? 'socket' : 'top',
      content: labelNode(name, bits),
      tone: TONE[s.level],
    });
    labelled.add(s.key);
  }
  for (const key of [hovered, selected]) {
    if (!key || labelled.has(key) || byKey.has(key) || key === 'shell') continue;
    const part = model.byKey.get(key);
    if (!part) continue;
    labels.push({ key, at: 'center', content: labelNode(part.label, []) });
    labelled.add(key);
  }

  // Selecting something that lives inside the case lifts the shell enough to see it.
  let xray = XRAY[lens];
  if (selected && model.byKey.has(selected)) {
    const outside = exteriorParts(model);
    if (outside && !outside.has(selected)) xray = Math.max(xray, 0.55);
  }

  return {
    visuals,
    defaultVisual,
    flows: lens === 'traffic' && status === 'ok' ? flowsFor(slots, model) : [],
    labels,
    xray,
  };
}
