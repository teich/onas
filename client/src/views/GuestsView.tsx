import { useEffect, useMemo, useState } from 'react';
import type { DashboardState, Guest, GuestConfigEntry, HistoryMatrix } from '../lib/types';
import { deleteGuest, fetchHistory, guestAction } from '../lib/api';
import { ActivityHeatmap, METRICS, type HeatRow } from '../viz/ActivityHeatmap';
import { ConfirmTyped, Freshness, Meter, Panel, StatusBadge } from '../components/ui';
import { fmtBytes, fmtDuration, fmtPct, fmtRate } from '../lib/format';
import { SERIES } from '../lib/palette';
import { navigate } from '../App';
import { CpuPanel } from './CpuPanel';

function templateUrl(url: string | undefined, guest: Guest): string | undefined {
  if (!url) return undefined;
  return url.split('{vmid}').join(String(guest.vmid)).split('{name}').join(encodeURIComponent(guest.name));
}

// guests.json is keyed by VMID, which Proxmox reuses: an entry labelled for another name
// was written for a guest that's since been deleted, so it doesn't apply.
function guestConfig(state: DashboardState, guest: Guest): GuestConfigEntry {
  const entry = state.guestsConfig.guests?.[String(guest.vmid)] ?? {};
  const own = !entry.label || entry.label === guest.name ? entry : {};
  return { ...(state.guestsConfig.defaults?.[guest.type] ?? {}), ...own };
}

function GuestRow({ state, guest, busy, onAction, onDelete }: {
  state: DashboardState;
  guest: Guest;
  busy: boolean;
  onAction: (g: Guest, action: string) => void;
  onDelete: (g: Guest) => void;
}) {
  const cfg = guestConfig(state, guest);
  const links = (cfg.links ?? []).map(l => ({ label: l.label, url: templateUrl(l.url, guest) ?? '' })).filter(l => l.label && l.url);
  const dash = templateUrl(cfg.dash, guest);
  const open = templateUrl(cfg.open, guest);
  const running = guest.status === 'running';
  const memFrac = guest.maxmem ? (guest.mem ?? 0) / guest.maxmem : 0;
  const binds = state.mounts.filter(m => m.vmid === guest.vmid && m.kind === 'bind');
  return (
    <tr className={running ? '' : 'stopped'}>
      <td className="num muted">{guest.vmid}</td>
      <td>
        <div className="guest-name">{dash ? <a href={dash} target="_blank" rel="noreferrer">{guest.name}</a> : guest.name}<span className="type-tag">{guest.type === 'vm' ? 'VM' : 'LXC'}</span></div>
        <div className="chips">
          {links.map(l => <a key={l.label} className="chip" href={l.url} target="_blank" rel="noreferrer">{l.label}</a>)}
          {binds.map(m => <span key={m.slot} className="chip muted-chip" title={`${m.source} → ${m.target}`}>{m.dataset ?? m.source}{m.readOnly ? ' (ro)' : ''}</span>)}
        </div>
      </td>
      <td>{running ? <StatusBadge level="good">running</StatusBadge> : guest.status === 'stopped' ? <span className="muted">stopped</span> : <StatusBadge level="warning">{guest.status}</StatusBadge>}
        {guest.lock && <StatusBadge level="warning">{guest.lock}</StatusBadge>}</td>
      <td className="num">{running ? fmtDuration(guest.uptime) : '—'}</td>
      <td className="num metric"><Meter value={guest.cpu ?? 0} max={1} color={SERIES[0]} />{running ? fmtPct(guest.cpu ?? 0, 1) : '—'}<span className="muted"> of {guest.maxcpu}</span></td>
      <td className="num metric"><Meter value={memFrac} max={1} color={SERIES[0]} />{fmtBytes(guest.mem ?? 0)}<span className="muted"> / {fmtBytes(guest.maxmem ?? 0)}</span></td>
      <td className="num">{running ? <>↓ {fmtRate(guest.netinRate)}<br />↑ {fmtRate(guest.netoutRate)}</> : '—'}</td>
      <td className="row-actions">
        {running && <button className="ghost" disabled={busy} onClick={() => onAction(guest, 'restart')}>Restart</button>}
        {running && <button className="ghost" disabled={busy} onClick={() => onAction(guest, 'shutdown')}>Shut down</button>}
        {!running && guest.status !== 'paused' && <button className="ghost" disabled={busy} onClick={() => onAction(guest, 'start')}>Start</button>}
        {guest.status === 'paused' && <button className="ghost" disabled={busy} onClick={() => onAction(guest, 'resume')}>Resume</button>}
        <button className="ghost" disabled={busy} onClick={() => onAction(guest, 'snapshot')}>Snapshot</button>
        {open && <a className="button ghost" href={open}>Console</a>}
        {!running && <button className="ghost danger-text" disabled={busy} onClick={() => onDelete(guest)}>Delete…</button>}
      </td>
    </tr>
  );
}

export function GuestsView({ state }: { state: DashboardState }) {
  const [metricKey, setMetricKey] = useState('cpu');
  const [hours, setHours] = useState(24);
  const [matrix, setMatrix] = useState<HistoryMatrix | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<Guest | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const metric = METRICS.find(m => m.key === metricKey)!;

  useEffect(() => {
    let cancelled = false;
    const load = () => fetchHistory(metricKey, hours)
      .then(m => { if (!cancelled) { setMatrix(m); setHistoryError(null); } })
      .catch(e => { if (!cancelled) setHistoryError((e as Error).message); });
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [metricKey, hours]);

  const guests = useMemo(() => [...state.guests].sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || a.vmid - b.vmid), [state.guests]);
  const heatRows: HeatRow[] = useMemo(() => [
    { id: 'host', label: state.host?.hostname ?? 'host', sublabel: 'host' },
    ...guests.filter(g => g.status === 'running').map(g => ({ id: String(g.vmid), label: g.name, sublabel: String(g.vmid) })),
  ], [guests, state.host?.hostname]);

  const onAction = async (g: Guest, action: string) => {
    if (action === 'snapshot') {
      navigate('snapshots', { dataset: state.mounts.find(m => m.vmid === g.vmid && (m.kind === 'rootfs' || m.kind === 'disk'))?.dataset ?? '' });
      return;
    }
    setBusy(g.vmid);
    setActionError(null);
    try { await guestAction(g.vmid, action); } catch (e) { setActionError(`${g.name}: ${(e as Error).message}`); } finally { setBusy(null); }
  };

  return (
    <div className="view">
      <CpuPanel state={state} />

      <Panel
        title="Activity"
        aside={<>
          <div className="segmented" role="group" aria-label="Metric">
            {METRICS.map(m => <button key={m.key} className={metricKey === m.key ? 'on' : ''} onClick={() => setMetricKey(m.key)}>{m.label}</button>)}
          </div>
          <div className="segmented" role="group" aria-label="Range">
            {[24, 168].map(h => <button key={h} className={hours === h ? 'on' : ''} onClick={() => setHours(h)}>{h === 24 ? '24h' : '7d'}</button>)}
          </div>
          <Freshness collector={state.collectors.history} />
        </>}
      >
        {historyError && <div className="form-error">{historyError}</div>}
        <ActivityHeatmap matrix={matrix} rows={heatRows} metric={metric} />
      </Panel>

      <Panel title="Guests" aside={<Freshness collector={state.collectors.pve} />}>
        {actionError && <div className="form-error">{actionError}</div>}
        <table className="table guests-table">
          <thead><tr><th className="num">ID</th><th>Guest</th><th>State</th><th className="num">Up</th><th className="num">CPU</th><th className="num">Memory</th><th className="num">Network</th><th /></tr></thead>
          <tbody>
            {guests.map(g => <GuestRow key={g.vmid} state={state} guest={g} busy={busy === g.vmid} onAction={onAction} onDelete={setDeleting} />)}
          </tbody>
        </table>
      </Panel>

      {deleting && (
        <ConfirmTyped title={`Delete ${deleting.name}?`} expect={String(deleting.vmid)} action="Delete guest"
          body={<p>Destroys {deleting.type === 'vm' ? 'VM' : 'container'} {deleting.vmid} and its disks. Backups in PBS are kept.</p>}
          onConfirm={() => deleteGuest(deleting.vmid, String(deleting.vmid))} onClose={() => setDeleting(null)} />
      )}
    </div>
  );
}
