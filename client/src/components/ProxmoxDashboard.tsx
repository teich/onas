import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deleteGuest, fetchState, guestActionByRoute } from '../lib/api';
import type { ActivityEntry, DashboardState, Dataset, Guest, GuestConfigEntry, Snapshot } from '../lib/types';
import { fmtBytes, parseSize, timeAgo } from '../lib/helpers';

interface RatePoint {
  at: number;
  cpu: number;
  ram: number;
  iowait: number;
  netIn: number;
  netOut: number;
}

interface GuestRate {
  at: number;
  netin: number;
  netout: number;
}

const EMPTY_STATE: DashboardState = {
  host: null,
  guests: [],
  pools: [],
  datasets: [],
  snapshots: [],
  updates: { count: 0, packages: [], raw: '', checkedAt: null },
  activity: [],
  guestsConfig: {},
  timestamp: new Date(0).toISOString(),
};

function fmtUptime(seconds?: number): string {
  if (!seconds) return '';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function templateUrl(url: string | undefined, guest: Guest): string | undefined {
  if (!url) return undefined;
  return url.split('{vmid}').join(String(guest.vmid)).split('{name}').join(encodeURIComponent(guest.name));
}

function guestConfig(state: DashboardState, guest: Guest): GuestConfigEntry {
  const byId = state.guestsConfig.guests?.[String(guest.vmid)] ?? {};
  const defaults = state.guestsConfig.defaults?.[guest.type] ?? {};
  return { ...defaults, ...byId };
}

function guestDiskDatasets(datasets: Dataset[], vmid: number): Dataset[] {
  const re = new RegExp(`/(?:vm|subvol)-${vmid}-disk-\\d+$`);
  return datasets.filter(ds => re.test(ds.name));
}

function diskTotal(datasets: Dataset[], guest: Guest): number {
  const fromStats = guest.maxdisk || guest.disk || 0;
  if (fromStats > 0) return fromStats;
  return guestDiskDatasets(datasets, guest.vmid).reduce((sum, ds) => sum + parseSize(ds.volsize || ds.used), 0);
}

function pct(value?: number): string {
  return `${Math.max(0, Math.min(100, value ?? 0)).toFixed(1)}%`;
}

function MiniBar({ value, warnAt = 85 }: { value: number; warnAt?: number }) {
  const color = value >= warnAt ? 'var(--red)' : value >= 75 ? 'var(--amber)' : 'var(--cyan)';
  return (
    <span className="dash-mini-bar" aria-hidden="true">
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color }} />
    </span>
  );
}

function Sparkline({ points, pick, className }: {
  points: RatePoint[];
  pick: (point: RatePoint) => number;
  className?: string;
}) {
  const values = points.map(pick);
  const max = Math.max(1, ...values);
  const d = values.map((v, i) => {
    const x = values.length <= 1 ? 0 : (i / (values.length - 1)) * 100;
    const y = 34 - (v / max) * 30;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  return (
    <svg className={className ?? 'spark'} viewBox="0 0 100 36" preserveAspectRatio="none">
      <path d={d || 'M0,34'} />
    </svg>
  );
}

function HostBar({ state, stale }: {
  state: DashboardState;
  stale: boolean;
}) {
  const host = state.host;
  const ramPct = host ? (host.mem.usedBytes / Math.max(1, host.mem.totalBytes)) * 100 : 0;
  const patches = state.updates.patches ?? 0;
  const updates = state.updates.updates ?? state.updates.count;
  const upgrades = state.updates.upgrades ?? 0;
  return (
    <div className="host-strip">
      <div className="host-strip-main">
        <span className={`status-pill ${host ? 'running' : 'error'}`}>{host ? 'online' : 'disconnected'}</span>
        <strong>{host?.hostname || 'proxmox'}</strong>
        <span><span className="muted">CPU</span> {pct(host?.cpu.pct)} <MiniBar value={host?.cpu.pct ?? 0} /></span>
        <span className={ramPct > 85 ? 'danger' : ''}><span className="muted">MEM</span> {host ? `${fmtBytes(host.mem.usedBytes)} / ${fmtBytes(host.mem.totalBytes)}` : '0 B / 0 B'} <MiniBar value={ramPct} /></span>
        <span title={host ? `${host.load.load5.toFixed(2)} / ${host.load.load15.toFixed(2)}` : ''}><span className="muted">LOAD</span> {host?.load.load1.toFixed(2) ?? '-'}</span>
        <span><span className="muted">UP</span> {fmtUptime(host?.uptimeSeconds) || '-'}</span>
        <span title={host?.kernel ?? ''}><span className="muted">KERNEL</span> {host?.kernel ? 'hover' : '-'}</span>
      </div>
      <span className={`updates-button passive ${state.updates.count > 0 ? 'warn' : ''}`} title={state.updates.raw || 'No package update output cached'}>
        {state.updates.count > 0 ? `${patches} patches · ${updates} updates · ${upgrades} upgrades` : 'apt current'} {stale ? ' stale' : ''}
      </span>
    </div>
  );
}

function GuestActions({ guest, config, busy, onAction, onDelete }: {
  guest: Guest;
  config: GuestConfigEntry;
  busy: boolean;
  onAction: (guest: Guest, action: string) => void;
  onDelete: (guest: Guest) => void;
}) {
  const dash = templateUrl(config.dash, guest);
  const open = templateUrl(config.open, guest) || (guest.type === 'lxc' ? `ssh://lxc-${guest.vmid}` : undefined);
  const running = guest.status === 'running';
  return (
    <div className="guest-actions" onClick={event => event.stopPropagation()}>
      {dash && <a href={dash} target="_blank" rel="noreferrer">Dash</a>}
      {running && <button disabled={busy} onClick={() => onAction(guest, 'stop')}>Stop</button>}
      {running && <button disabled={busy} onClick={() => onAction(guest, 'restart')}>Restart</button>}
      {!running && guest.status !== 'paused' && <button disabled={busy} onClick={() => onAction(guest, 'start')}>Start</button>}
      {guest.status === 'paused' && <button disabled={busy} onClick={() => onAction(guest, 'resume')}>Resume</button>}
      {open && <a href={open}>Open</a>}
      <button disabled={busy} onClick={() => onAction(guest, 'snapshot')}>Snap</button>
      {!running && <button disabled={busy} className="danger-btn" onClick={() => onDelete(guest)}>Delete</button>}
    </div>
  );
}

function GuestsPanel({ state, guestRates, busyGuest, onAction, onDelete }: {
  state: DashboardState;
  guestRates: Record<number, { inRate: number; outRate: number }>;
  busyGuest: number | null;
  onAction: (guest: Guest, action: string) => void;
  onDelete: (guest: Guest) => void;
}) {
  type SortKey = 'type' | 'vmid' | 'name' | 'status' | 'uptime' | 'cpu' | 'ram' | 'disk' | 'net';
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'status', dir: 'asc' });
  const statusRank: Record<string, number> = { running: 0, booting: 1, paused: 2, stopping: 3, stopped: 4, error: 5, unknown: 6 };
  const sortValue = (guest: Guest, key: SortKey): string | number => {
    const rate = guestRates[guest.vmid] ?? { inRate: 0, outRate: 0 };
    if (key === 'type') return guest.type;
    if (key === 'vmid') return guest.vmid;
    if (key === 'name') return guestConfig(state, guest).label || guest.name;
    if (key === 'status') return statusRank[guest.status] ?? statusRank.unknown;
    if (key === 'uptime') return guest.uptime ?? 0;
    if (key === 'cpu') return guest.cpu ?? 0;
    if (key === 'ram') return guest.maxmem ? (guest.mem ?? 0) / guest.maxmem : 0;
    if (key === 'disk') return diskTotal(state.datasets, guest);
    return rate.inRate + rate.outRate;
  };
  const setSortKey = (key: SortKey) => {
    setSort(current => current.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' || key === 'type' || key === 'status' ? 'asc' : 'desc' });
  };
  const sortLabel = (key: SortKey, label: string) => `${label}${sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}`;
  const rows = [...state.guests].sort((a, b) => {
    const av = sortValue(a, sort.key);
    const bv = sortValue(b, sort.key);
    const cmp = typeof av === 'string' || typeof bv === 'string'
      ? String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' })
      : av - bv;
    return (sort.dir === 'asc' ? cmp : -cmp) || a.vmid - b.vmid;
  });
  return (
    <section className="dense-section guests-panel">
      <div className="dense-title"><span>Guests</span><span>{rows.length} guests</span></div>
      <div className="guest-grid guest-head">
        <button onClick={() => setSortKey('type')}>{sortLabel('type', 'Type')}</button>
        <button onClick={() => setSortKey('vmid')}>{sortLabel('vmid', 'ID')}</button>
        <button onClick={() => setSortKey('name')}>{sortLabel('name', 'Name')}</button>
        <button onClick={() => setSortKey('status')}>{sortLabel('status', 'Status')}</button>
        <button onClick={() => setSortKey('uptime')}>{sortLabel('uptime', 'Uptime')}</button>
        <button onClick={() => setSortKey('cpu')}>{sortLabel('cpu', 'CPU')}</button>
        <button onClick={() => setSortKey('ram')}>{sortLabel('ram', 'RAM')}</button>
        <button onClick={() => setSortKey('disk')}>{sortLabel('disk', 'Disk')}</button>
        <button onClick={() => setSortKey('net')}>{sortLabel('net', 'Net I/O')}</button>
        <span>Actions</span>
      </div>
      {rows.map(guest => {
        const cfg = guestConfig(state, guest);
        const dash = templateUrl(cfg.dash, guest);
        const ramPct = guest.maxmem ? (guest.mem ?? 0) / guest.maxmem * 100 : 0;
        const rate = guestRates[guest.vmid] ?? { inRate: 0, outRate: 0 };
        const disks = guestDiskDatasets(state.datasets, guest.vmid);
        return (
          <div
            className={`guest-grid guest-row ${dash ? 'clickable' : ''}`}
            key={guest.vmid}
            onClick={() => { if (dash) window.open(dash, '_blank', 'noopener,noreferrer'); }}
            title={dash ? `Open ${dash}` : undefined}
          >
            <span className={`type-badge ${guest.type}`}>{guest.type.toUpperCase()}</span>
            <span className="num">{guest.vmid}</span>
            <span className="guest-name">{cfg.label || guest.name}</span>
            <span><i className={`state-dot ${guest.status}`} />{guest.status}</span>
            <span className="num">{fmtUptime(guest.uptime)}</span>
            <span className="metric-cell"><MiniBar value={(guest.cpu ?? 0) * 100} />{pct((guest.cpu ?? 0) * 100)}</span>
            <span className="metric-cell"><MiniBar value={ramPct} />{guest.maxmem ? `${fmtBytes(guest.mem ?? 0)} / ${fmtBytes(guest.maxmem)}` : '-'}</span>
            <span className="num" title={disks.map(ds => ds.name).join('\n')}>{fmtBytes(diskTotal(state.datasets, guest))}</span>
            <span className="num">{fmtBytes(rate.inRate)}/s<br />{fmtBytes(rate.outRate)}/s</span>
            <GuestActions guest={guest} config={cfg} busy={busyGuest === guest.vmid} onAction={onAction} onDelete={onDelete} />
          </div>
        );
      })}
    </section>
  );
}

function StoragePanel({ state }: { state: DashboardState }) {
  return (
    <section className="dense-section storage-panel">
      <div className="dense-title"><span>Storage</span><span>{state.pools.length} pools</span></div>
      <div className="pool-summary-head"><span>Pool</span><span>Used / Total</span><span>Used</span><span>Health</span><span>Scan / Errors</span></div>
      {state.pools.map(pool => (
        <div className="pool-summary-row" key={pool.name}>
          <span>{pool.name}</span>
          <span className={pool.cap > 85 ? 'danger' : pool.cap > 75 ? 'warn-text' : ''}>{pool.alloc} / {pool.size}</span>
          <span className="metric-cell"><MiniBar value={pool.cap} />{pool.cap}%</span>
          <span className={`health ${pool.health.toLowerCase()}`}>{pool.health}</span>
          <span className="pool-notes" title={[pool.scan, pool.errors].filter(Boolean).join('\n')}>{pool.errors || pool.scan || '-'}</span>
        </div>
      ))}
    </section>
  );
}

function SnapshotsPanel({ snapshots }: { snapshots: Snapshot[] }) {
  const grouped = new Map<string, Snapshot[]>();
  snapshots.forEach(snapshot => {
    if (!grouped.has(snapshot.dataset)) grouped.set(snapshot.dataset, []);
    grouped.get(snapshot.dataset)!.push(snapshot);
  });
  const rows = [...grouped.entries()].map(([dataset, snaps]) => {
    const newest = snaps.reduce((best, snap) => new Date(snap.createdAt) > new Date(best.createdAt) ? snap : best, snaps[0]);
    const used = snaps.reduce((sum, snap) => sum + snap.usedBytes, 0);
    return { dataset, snaps, newest, used };
  }).sort((a, b) => new Date(b.newest.createdAt).getTime() - new Date(a.newest.createdAt).getTime());
  return (
    <section className="dense-section snapshots-panel">
      <div className="dense-title"><span>ZFS Snapshots</span><span>{snapshots.length} snaps</span></div>
      <div className="snapshot-head"><span>Dataset</span><span>Count</span><span>Used</span><span>Newest</span><span>Action</span></div>
      {rows.slice(0, 14).map(row => (
        <div className="snapshot-row" key={row.dataset}>
          <span title={row.dataset}>{row.dataset}</span>
          <span className="num">{row.snaps.length}</span>
          <span className="num">{fmtBytes(row.used)}</span>
          <span className="num">{timeAgo(row.newest.createdAt)}</span>
          <button>+ Snapshot</button>
        </div>
      ))}
    </section>
  );
}

function ChartsRail({ history, activity }: { history: RatePoint[]; activity: ActivityEntry[] }) {
  return (
    <aside className="charts-rail">
      <div className="rail-block"><div className="rail-title">Node CPU</div><Sparkline points={history} pick={p => p.cpu} /></div>
      <div className="rail-block"><div className="rail-title">Node RAM</div><Sparkline points={history} pick={p => p.ram} /></div>
      <div className="rail-block"><div className="rail-title">I/O Wait</div><Sparkline points={history} pick={p => p.iowait} /></div>
      <div className="rail-block"><div className="rail-title">Network</div><Sparkline points={history} pick={p => Math.max(p.netIn, p.netOut)} className="spark net" /></div>
      <div className="rail-block activity-block">
        <div className="rail-title">Activity</div>
        {activity.length === 0 && <div className="empty-log">No dashboard actions yet</div>}
        {activity.slice(0, 20).map(item => (
          <details key={item.id} className={item.exitCode === 0 ? '' : 'failed'}>
            <summary><span>{new Date(item.timestamp).toLocaleTimeString()}</span><span>{item.action}</span><span>{item.target}</span></summary>
            <pre>{[item.stdout, item.stderr].filter(Boolean).join('\n') || `exit ${item.exitCode}`}</pre>
          </details>
        ))}
      </div>
    </aside>
  );
}

export function ProxmoxDashboard() {
  const [state, setState] = useState<DashboardState>(EMPTY_STATE);
  const [error, setError] = useState<string | null>(null);
  const [busyGuest, setBusyGuest] = useState<number | null>(null);
  const [history, setHistory] = useState<RatePoint[]>([]);
  const [guestRates, setGuestRates] = useState<Record<number, { inRate: number; outRate: number }>>({});
  const lastGuestRatesRef = useRef<Record<number, GuestRate>>({});
  const guestRatesRef = useRef<Record<number, { inRate: number; outRate: number }>>({});

  const load = useCallback(async () => {
    try {
      const next = await fetchState();
      setState(previous => {
        const preserveStorage = previous.pools.length > 0 && next.pools.length === 0 && next.datasets.length === 0 && next.snapshots.length === 0;
        return preserveStorage
          ? { ...next, pools: previous.pools, datasets: previous.datasets, snapshots: previous.snapshots }
          : next;
      });
      setError(null);
      const now = Date.now();
      const previousRates = lastGuestRatesRef.current;
      const nextRates: Record<number, { inRate: number; outRate: number }> = {};
      const freshRates: Record<number, GuestRate> = {};
      for (const guest of next.guests) {
        const old = previousRates[guest.vmid];
        freshRates[guest.vmid] = { at: now, netin: guest.netin ?? 0, netout: guest.netout ?? 0 };
        if (old && now > old.at) {
          const secs = (now - old.at) / 1000;
          nextRates[guest.vmid] = {
            inRate: Math.max(0, ((guest.netin ?? 0) - old.netin) / secs),
            outRate: Math.max(0, ((guest.netout ?? 0) - old.netout) / secs),
          };
        } else {
          nextRates[guest.vmid] = guestRatesRef.current[guest.vmid] ?? { inRate: 0, outRate: 0 };
        }
      }
      lastGuestRatesRef.current = freshRates;
      guestRatesRef.current = nextRates;
      setGuestRates(nextRates);
      setHistory(prev => {
        const ram = next.host ? (next.host.mem.usedBytes / Math.max(1, next.host.mem.totalBytes)) * 100 : 0;
        const netIn = next.guests.reduce((sum, guest) => sum + (guest.netin ?? 0), 0);
        const netOut = next.guests.reduce((sum, guest) => sum + (guest.netout ?? 0), 0);
        const point = { at: Date.now(), cpu: next.host?.cpu.pct ?? 0, ram, iowait: 0, netIn, netOut };
        return [...prev, point].slice(-360);
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const id = window.setInterval(load, 2000);
    return () => window.clearInterval(id);
  }, [load]);

  const stale = useMemo(() => Date.now() - new Date(state.timestamp).getTime() > 10_000, [state.timestamp]);

  const onAction = async (guest: Guest, action: string) => {
    if (action === 'snapshot') {
      alert(`Snapshot dialog is deferred. Guest ${guest.vmid} disks are listed in the snapshot panel.`);
      return;
    }
    setBusyGuest(guest.vmid);
    try {
      await guestActionByRoute(guest.vmid, action);
      await load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusyGuest(null);
    }
  };

  const onDelete = async (guest: Guest) => {
    const confirmText = window.prompt(`Type ${guest.vmid} to delete ${guest.name}`);
    if (confirmText !== String(guest.vmid)) return;
    setBusyGuest(guest.vmid);
    try {
      await deleteGuest(guest.vmid, confirmText);
      await load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusyGuest(null);
    }
  };

  return (
    <div className="proxmox-app">
      <HostBar state={state} stale={stale || !!error} />
      {error && <div className="dash-error">Backend/state error: {error}. Showing last known state where available.</div>}
      <main className="dashboard-shell">
        <div className="dashboard-main">
          <GuestsPanel state={state} guestRates={guestRates} busyGuest={busyGuest} onAction={onAction} onDelete={onDelete} />
          <div className="lower-grid">
            <StoragePanel state={state} />
            <SnapshotsPanel snapshots={state.snapshots} />
          </div>
        </div>
        <ChartsRail history={history} activity={state.activity} />
      </main>
    </div>
  );
}
