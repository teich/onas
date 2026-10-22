import { useEffect, useMemo, useState } from 'react';
import type { DashboardState, Snapshot } from '../lib/types';
import { createSnapshot, destroySnapshot, rollbackSnapshot } from '../lib/api';
import { ConfirmTyped, Empty, Freshness, Modal, Panel, StatusBadge } from '../components/ui';
import { defaultSnapName, fmtBytes, fmtDateTime, timeAgo } from '../lib/format';
import { poolColor } from '../lib/palette';
import { isGuestDisk, poolOf } from '../lib/storageModel';
import { coverageLevel, ORIGIN_COLOR, ORIGIN_LABEL, snapshotOrigin, SnapshotTimeline, type TimelineRow } from '../viz/SnapshotTimeline';

type Filter = 'data' | 'guests' | 'all';

// Datasets below this hold no real data yet (empty placeholders); they aren't "exposed".
const MEANINGFUL = 64 * 1024 * 1024;

function guestLabel(state: DashboardState, dataset: string): string {
  const m = dataset.match(/(?:subvol|vm|base)-(\d+)-disk-(\d+)/);
  if (!m) return dataset;
  const g = state.guests.find(x => x.vmid === Number(m[1]));
  return `${g?.name ?? `guest ${m[1]}`}${m[2] !== '0' ? ` disk ${m[2]}` : ''}`;
}

function SnapshotNow({ dataset, onClose }: { dataset: string; onClose: () => void }) {
  const [name, setName] = useState(defaultSnapName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try { await createSnapshot(dataset, name.trim()); onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Snapshot ${dataset}`} onClose={onClose}>
      <div className="form">
        <label className="field"><span>Name</span><input autoFocus value={name} onChange={e => setName(e.target.value)} spellCheck={false} onKeyDown={e => { if (e.key === 'Enter') go(); }} /></label>
        <small className="muted">A ZFS snapshot is instant and takes no space until files change.</small>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !name.trim()} onClick={go}>{busy ? 'Taking…' : 'Take snapshot'}</button>
        </div>
      </div>
    </Modal>
  );
}

export function SnapshotsView({ state, params }: { state: DashboardState; params: URLSearchParams }) {
  const [filter, setFilter] = useState<Filter>(params.get('dataset') && isGuestDisk(params.get('dataset')!) ? 'guests' : 'data');
  const [selected, setSelected] = useState<Snapshot | null>(null);
  const [focus, setFocus] = useState<string | null>(params.get('dataset'));
  const [snapFor, setSnapFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'rollback' | 'destroy'; snap: Snapshot } | null>(null);

  useEffect(() => { if (params.get('dataset')) setFocus(params.get('dataset')); }, [params]);
  // Drop the selection if the snapshot disappears (destroyed, or rolled past).
  useEffect(() => {
    if (selected && !state.snapshots.some(s => s.name === selected.name)) setSelected(null);
  }, [state.snapshots, selected]);

  const rows = useMemo((): TimelineRow[] => {
    const bySet = new Map<string, Snapshot[]>();
    for (const s of state.snapshots) {
      if (!bySet.has(s.dataset)) bySet.set(s.dataset, []);
      bySet.get(s.dataset)!.push(s);
    }
    // Data rows: every filesystem below the pool root that isn't a guest disk and holds data.
    const data: TimelineRow[] = state.datasets
      .filter(d => d.type === 'filesystem' && d.name.includes('/') && !isGuestDisk(d.name) && (d.usedByDataset >= MEANINGFUL || bySet.has(d.name)))
      .sort((a, b) => b.used - a.used)
      .map(d => ({ dataset: d.name, label: d.name, sublabel: fmtBytes(d.usedByDataset), snapshots: bySet.get(d.name) ?? [], protect: d.usedByDataset >= MEANINGFUL }));
    const guests: TimelineRow[] = [...bySet.keys()]
      .filter(isGuestDisk)
      .sort()
      .map(name => ({ dataset: name, label: guestLabel(state, name), sublabel: name.split('/').pop()!, snapshots: bySet.get(name)!, protect: false }));
    return filter === 'data' ? data : filter === 'guests' ? guests : [...data, ...guests];
  }, [state, filter]);

  const dataRows = useMemo(() => state.datasets.filter(d => d.type === 'filesystem' && d.name.includes('/') && !isGuestDisk(d.name) && d.usedByDataset >= MEANINGFUL), [state.datasets]);
  const exposed = dataRows
    .map(d => ({ d, level: coverageLevel({ dataset: d.name, label: '', sublabel: '', protect: true, snapshots: state.snapshots.filter(s => s.dataset === d.name) }) }))
    .filter(x => x.level === 'critical')
    .sort((a, b) => b.d.used - a.d.used);
  const exposedBytes = exposed.reduce((s, x) => s + x.d.usedByDataset, 0);
  const held = state.datasets.reduce((s, d) => s + (d.usedBySnapshots || 0), 0);
  const newest = state.snapshots[0];

  const focusSet = selected?.dataset ?? focus;
  const focusSnaps = focusSet ? state.snapshots.filter(s => s.dataset === focusSet) : [];

  return (
    <div className="view">
      <div className="tile-row">
        <div className="stat-tile"><span className="muted">Snapshots</span><span className="hero-number">{state.snapshots.length}</span><span className="muted">{newest ? `newest ${timeAgo(newest.createdAt)}` : 'none'}</span></div>
        <div className="stat-tile"><span className="muted">Space held only by snapshots</span><span className="hero-number">{fmtBytes(held)}</span></div>
        <div className={`stat-tile${exposed.length ? ' alert' : ''}`}>
          <span className="muted">Data with no snapshot in 7 days</span>
          <span className="hero-number">{fmtBytes(exposedBytes)}</span>
          {exposed.length ? <StatusBadge level="critical">{exposed.length} datasets</StatusBadge> : <StatusBadge level="good">all covered</StatusBadge>}
        </div>
      </div>

      {exposed.length > 0 && (
        <div className="callout">
          <StatusBadge level="critical">Unprotected</StatusBadge>
          <div>
            <strong>{exposed.slice(0, 4).map(x => x.d.name).join(', ')}{exposed.length > 4 ? ` and ${exposed.length - 4} more` : ''}</strong> have no recent snapshot.
            Bind mounts are excluded from the nightly PBS backups, so a deleted or encrypted file there has no undo.
            Automatic ZFS snapshots for these are on the WTR backlog, waiting for your go-ahead.
          </div>
        </div>
      )}

      <Panel
        title="Timeline"
        aside={<>
          <div className="segmented" role="group" aria-label="Rows">
            {(['data', 'guests', 'all'] as Filter[]).map(f => (
              <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f === 'data' ? 'Data' : f === 'guests' ? 'Guest disks' : 'All'}</button>
            ))}
          </div>
          <Freshness collector={state.collectors.zfs} />
        </>}
      >
        {rows.length === 0 ? <Empty>No datasets to show.</Empty> : (
          <SnapshotTimeline
            rows={rows}
            selected={selected}
            onSelect={s => { setSelected(s); if (s) setFocus(s.dataset); }}
            renderLabel={row => {
              const level = coverageLevel(row);
              return (
                <div className={`tl-label${focusSet === row.dataset ? ' on' : ''}`} onClick={() => setFocus(row.dataset)}>
                  <span className="tl-name"><i className="swatch" style={{ background: poolColor(poolOf(row.dataset)) }} />{row.label}</span>
                  <span className="tl-sub">
                    <span className="muted">{row.sublabel}</span>
                    {level === 'critical' && <StatusBadge level="critical">{row.snapshots.length ? 'stale' : 'none'}</StatusBadge>}
                    {level === 'warning' && <StatusBadge level="warning">aging</StatusBadge>}
                  </span>
                  <button className="tl-snap" title={`Snapshot ${row.dataset} now`} onClick={e => { e.stopPropagation(); setSnapFor(row.dataset); }}>+</button>
                </div>
              );
            }}
          />
        )}
      </Panel>

      {focusSet && (
        <Panel title={<><code>{focusSet}</code> snapshots</>} aside={<button className="primary" onClick={() => setSnapFor(focusSet)}>Snapshot now</button>}>
          {focusSnaps.length === 0 ? <Empty>No snapshots of this dataset.</Empty> : (
            <table className="table">
              <thead><tr><th>Snapshot</th><th>Taken</th><th>Origin</th><th className="num">Holds</th><th className="num">Refers to</th><th /></tr></thead>
              <tbody>
                {focusSnaps.map(s => {
                  const origin = snapshotOrigin(s);
                  return (
                    <tr key={s.name} className={selected?.name === s.name ? 'selected' : ''} onClick={() => setSelected(s)}>
                      <td><code>@{s.snapname}</code></td>
                      <td>{fmtDateTime(s.createdAt)} <span className="muted">{timeAgo(s.createdAt)}</span></td>
                      <td><i className="swatch dot" style={{ background: ORIGIN_COLOR[origin] }} />{ORIGIN_LABEL[origin]}</td>
                      <td className="num">{fmtBytes(s.usedBytes)}</td>
                      <td className="num">{fmtBytes(s.referBytes)}</td>
                      <td className="row-actions">
                        <button className="ghost" onClick={e => { e.stopPropagation(); setConfirm({ kind: 'rollback', snap: s }); }}>Roll back…</button>
                        <button className="ghost danger-text" onClick={e => { e.stopPropagation(); setConfirm({ kind: 'destroy', snap: s }); }}>Destroy…</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
      )}

      {snapFor && <SnapshotNow dataset={snapFor} onClose={() => setSnapFor(null)} />}
      {confirm?.kind === 'destroy' && (
        <ConfirmTyped title="Destroy snapshot?" expect={confirm.snap.snapname} action="Destroy"
          body={<p>Permanently deletes <code>{confirm.snap.name}</code> and frees {fmtBytes(confirm.snap.usedBytes)}. Files in the live dataset are not affected.</p>}
          onConfirm={() => destroySnapshot(confirm.snap.name)} onClose={() => setConfirm(null)} />
      )}
      {confirm?.kind === 'rollback' && (() => {
        const newer = state.snapshots.filter(s => s.dataset === confirm.snap.dataset && s.createdAt > confirm.snap.createdAt);
        return (
          <ConfirmTyped title="Roll back dataset?" expect={confirm.snap.dataset} action="Roll back"
            body={<>
              <p>Returns <code>{confirm.snap.dataset}</code> to how it was at {fmtDateTime(confirm.snap.createdAt)}. <strong>Every change since then is lost.</strong></p>
              {newer.length > 0 && <p>{newer.length} newer snapshot{newer.length === 1 ? '' : 's'} will be destroyed too: {newer.map(s => `@${s.snapname}`).join(', ')}.</p>}
              {isGuestDisk(confirm.snap.dataset) && <p>This is a guest disk; stop the guest first.</p>}
            </>}
            onConfirm={() => rollbackSnapshot(confirm.snap.name)} onClose={() => setConfirm(null)} />
        );
      })()}
    </div>
  );
}
