import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createSnapshot, deleteUser, deleteGuest, fetchState, fetchUsers, guestActionByRoute, putSmb, createUser } from '../lib/api';
import type { ActivityEntry, DashboardState, Dataset, Guest, GuestConfigEntry, Share, SmbUser, Snapshot } from '../lib/types';
import { defaultSnapName, fmtBytes, parseSize, timeAgo } from '../lib/helpers';

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
  shares: [],
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

function datasetShares(dataset: Dataset, shares: Share[]): Share[] {
  const mount = dataset.mountpoint;
  if (!mount || mount === '-' || mount === 'none') return [];
  return shares.filter(share => share.path === mount || share.path.startsWith(`${mount}/`));
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
            {dash ? (
              <a
                className="guest-name guest-name-link"
                href={dash}
                target="_blank"
                rel="noreferrer"
                onClick={event => event.stopPropagation()}
              >
                {cfg.label || guest.name}
              </a>
            ) : (
              <span className="guest-name">{cfg.label || guest.name}</span>
            )}
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
      <div className="snapshot-head"><span>Dataset</span><span>Snapshots</span><span>Used</span><span>Newest</span><span>Action</span></div>
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

function DatasetsPanel({ state, onOpen }: { state: DashboardState; onOpen: (dataset: Dataset) => void }) {
  const rows = state.datasets
    .filter(ds => ds.type === 'filesystem' && ds.mountpoint && ds.mountpoint !== '-' && ds.mountpoint !== 'none')
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return (
    <section className="dense-section datasets-panel">
      <div className="dense-title"><span>Datasets</span><span>{rows.length} mounted</span></div>
      <div className="dataset-head"><span>Dataset</span><span>Used</span><span>Avail</span><span>Refer</span><span>Mount</span><span>Snaps</span><span>Shares</span><span>Actions</span></div>
      {rows.slice(0, 28).map(ds => {
        const snaps = state.snapshots.filter(snapshot => snapshot.dataset === ds.name);
        const shares = datasetShares(ds, state.shares);
        const rootShares = shares.filter(share => share.path === ds.mountpoint).length;
        const shareLabel = shares.length === 0 ? '0' : rootShares > 0 && shares.length > rootShares ? `${rootShares} root + ${shares.length - rootShares} sub` : String(shares.length);
        return (
          <div className="dataset-row" key={ds.name}>
            <button className="dataset-link" onClick={() => onOpen(ds)} title={ds.name}>{ds.name}</button>
            <span className="num">{ds.used}</span>
            <span className="num">{ds.avail}</span>
            <span className="num">{ds.refer}</span>
            <span title={ds.mountpoint}>{ds.mountpoint}</span>
            <button onClick={() => onOpen(ds)}>{snaps.length}</button>
            <button onClick={() => onOpen(ds)}>{shareLabel}</button>
            <button onClick={() => onOpen(ds)}>Details</button>
          </div>
        );
      })}
    </section>
  );
}

function UsersModal({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<SmbUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    fetchUsers().then(data => setUsers(data.users ?? [])).catch(e => setError((e as Error).message));
  }, []);
  useEffect(() => { load(); }, [load]);
  const addUser = async () => {
    if (!username || !password) return;
    setBusy(true);
    setError(null);
    try {
      await createUser(username, password);
      setUsername('');
      setPassword('');
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const removeUser = async (name: string) => {
    if (!window.confirm(`Delete SMB user ${name}?`)) return;
    setBusy(true);
    try {
      await deleteUser(name);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="dense-modal users-modal" onClick={event => event.stopPropagation()}>
        <div className="modal-title"><span>SMB Users</span><button onClick={onClose}>Close</button></div>
        {error && <div className="modal-error">{error}</div>}
        <div className="users-list">
          {users.map(user => (
            <div className="user-line" key={user.username}>
              <span>{user.username}</span><span>{user.fullName || '-'}</span><button disabled={busy} onClick={() => removeUser(user.username)}>Delete</button>
            </div>
          ))}
        </div>
        <div className="share-form compact">
          <input value={username} onChange={e => setUsername(e.target.value)} placeholder="username" />
          <input value={password} onChange={e => setPassword(e.target.value)} placeholder="password" type="password" />
          <button disabled={busy || !username || !password} onClick={addUser}>Add User</button>
        </div>
      </div>
    </div>
  );
}

function DatasetModal({ dataset, state, onClose, onStatePatch }: {
  dataset: Dataset;
  state: DashboardState;
  onClose: () => void;
  onStatePatch: (patch: Partial<DashboardState>) => void;
}) {
  const [shares, setShares] = useState<Share[]>(datasetShares(dataset, state.shares));
  const [editing, setEditing] = useState<Share | null>(null);
  const [snapName, setSnapName] = useState(defaultSnapName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showUsers, setShowUsers] = useState(false);
  const snaps = state.snapshots
    .filter(snapshot => snapshot.dataset === dataset.name)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  useEffect(() => {
    setShares(datasetShares(dataset, state.shares));
    setEditing(null);
    setError(null);
  }, [dataset.name, state.shares]);

  const emptyShare = (): Share => ({
    name: dataset.name.split('/').pop() || dataset.name.replace(/[^a-z0-9_-]/gi, '-'),
    path: dataset.mountpoint,
    comment: '',
    readOnly: false,
    guestOk: false,
    browseable: true,
    inheritPermissions: true,
  });

  const saveShare = async (share: Share) => {
    setBusy(true);
    setError(null);
    try {
      const exists = state.shares.some(item => item.name === share.name);
      const nextShares = exists ? state.shares.map(item => item.name === share.name ? share : item) : [...state.shares, share];
      const data = await putSmb(nextShares);
      onStatePatch({ shares: data.shares ?? nextShares });
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeShare = async (share: Share) => {
    if (!window.confirm(`Delete SMB share ${share.name}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const nextShares = state.shares.filter(item => item.name !== share.name);
      const data = await putSmb(nextShares);
      onStatePatch({ shares: data.shares ?? nextShares });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const takeSnapshot = async () => {
    if (!snapName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createSnapshot(dataset.name, snapName.trim());
      setSnapName(defaultSnapName());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="dense-modal dataset-modal" onClick={event => event.stopPropagation()}>
        <div className="modal-title">
          <span>{dataset.name}</span>
          <div><button onClick={() => setShowUsers(true)}>Users</button><button onClick={onClose}>Close</button></div>
        </div>
        {error && <div className="modal-error">{error}</div>}
        <div className="dataset-modal-grid">
          <section>
            <div className="modal-section-title">Dataset</div>
            <div className="modal-props">
              <span>Mount</span><strong>{dataset.mountpoint}</strong>
              <span>Used</span><strong>{dataset.used}</strong>
              <span>Avail</span><strong>{dataset.avail}</strong>
              <span>Refer</span><strong>{dataset.refer}</strong>
              <span>Type</span><strong>{dataset.type}</strong>
            </div>
          </section>
          <section>
            <div className="modal-section-title">Snapshots</div>
            <div className="snap-create-row"><input value={snapName} onChange={e => setSnapName(e.target.value)} /><button disabled={busy || !snapName.trim()} onClick={takeSnapshot}>+ Snap</button></div>
            <div className="modal-list">
              {snaps.slice(0, 16).map(snapshot => (
                <div className="modal-list-row" key={snapshot.name}>
                  <span title={snapshot.snapname}>@{snapshot.snapname}</span><span>{fmtBytes(snapshot.usedBytes)}</span><span>{timeAgo(snapshot.createdAt)}</span>
                </div>
              ))}
              {snaps.length === 0 && <div className="empty-log">No snapshots</div>}
            </div>
          </section>
          <section className="shares-section">
            <div className="modal-section-title">SMB Shares</div>
            <div className="modal-list">
              {shares.map(share => (
                <div className="share-line" key={share.name}>
                  <span>{share.name}</span><span title={share.path}>{share.path}</span><span>{share.readOnly ? 'RO' : 'RW'}</span>
                  <button onClick={() => setEditing(share)}>Edit</button><button disabled={busy} onClick={() => removeShare(share)}>Delete</button>
                </div>
              ))}
              {shares.length === 0 && <div className="empty-log">No shares under this dataset</div>}
            </div>
            <button className="modal-primary" onClick={() => setEditing(emptyShare())}>+ Share Dataset</button>
          </section>
          {editing && (
            <section className="share-form-section">
              <div className="modal-section-title">{state.shares.some(item => item.name === editing.name) ? 'Edit Share' : 'New Share'}</div>
              <ShareForm share={editing} busy={busy} onCancel={() => setEditing(null)} onSave={saveShare} />
            </section>
          )}
        </div>
      </div>
      {showUsers && <UsersModal onClose={() => setShowUsers(false)} />}
    </div>
  );
}

function ShareForm({ share, busy, onCancel, onSave }: {
  share: Share;
  busy: boolean;
  onCancel: () => void;
  onSave: (share: Share) => void;
}) {
  const [form, setForm] = useState(share);
  useEffect(() => setForm(share), [share.name, share.path]);
  return (
    <div className="share-form">
      <input value={form.name} onChange={e => setForm(current => ({ ...current, name: e.target.value }))} placeholder="share name" />
      <input value={form.path} onChange={e => setForm(current => ({ ...current, path: e.target.value }))} placeholder="/mount/path" />
      <input value={form.comment} onChange={e => setForm(current => ({ ...current, comment: e.target.value }))} placeholder="comment" />
      <label><input type="checkbox" checked={form.readOnly} onChange={e => setForm(current => ({ ...current, readOnly: e.target.checked }))} /> read only</label>
      <label><input type="checkbox" checked={form.guestOk} onChange={e => setForm(current => ({ ...current, guestOk: e.target.checked }))} /> guest ok</label>
      <label><input type="checkbox" checked={form.browseable} onChange={e => setForm(current => ({ ...current, browseable: e.target.checked }))} /> browse</label>
      <label><input type="checkbox" checked={form.inheritPermissions} onChange={e => setForm(current => ({ ...current, inheritPermissions: e.target.checked }))} /> inherit perms</label>
      <div className="form-actions"><button disabled={busy || !form.name || !form.path} onClick={() => onSave(form)}>Save</button><button onClick={onCancel}>Cancel</button></div>
    </div>
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
  const [selectedDataset, setSelectedDataset] = useState<Dataset | null>(null);
  const lastGuestRatesRef = useRef<Record<number, GuestRate>>({});
  const guestRatesRef = useRef<Record<number, { inRate: number; outRate: number }>>({});

  const load = useCallback(async () => {
    try {
      const next = await fetchState();
      setState(previous => {
        const preserveStorage = previous.pools.length > 0 && next.pools.length === 0 && next.datasets.length === 0 && next.snapshots.length === 0;
        return preserveStorage
          ? { ...next, pools: previous.pools, datasets: previous.datasets, snapshots: previous.snapshots, shares: next.shares.length > 0 ? next.shares : previous.shares }
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
          <DatasetsPanel state={state} onOpen={setSelectedDataset} />
        </div>
        <ChartsRail history={history} activity={state.activity} />
      </main>
      {selectedDataset && (
        <DatasetModal
          dataset={selectedDataset}
          state={state}
          onClose={() => setSelectedDataset(null)}
          onStatePatch={patch => setState(current => ({ ...current, ...patch }))}
        />
      )}
    </div>
  );
}
