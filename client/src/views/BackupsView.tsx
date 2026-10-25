// What is backed up where and when: findings first, then what's running, the schedule, and
// coverage for every dataset and guest. The model is built on the server (server/backups-model.js).
import { useEffect, useState } from 'react';
import type { BackupSnap, BackupsState, DashboardState, OffsiteItem } from '../lib/types';
import { Empty, Freshness, Meter, Panel, StatusBadge } from '../components/ui';
import { fmtBytes, fmtDateTime, fmtDuration, timeAgo } from '../lib/format';
import { SERIES } from '../lib/palette';
import type { StatusLevel } from '../lib/palette';

const ms = (s: number | null | undefined) => (s == null ? null : s * 1000);

function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

function until(s: number, now: number): string {
  const secs = s - now / 1000;
  if (secs <= 0) return 'due now';
  if (secs < 3600) return `in ${Math.round(secs / 60)}m`;
  if (secs < 86400 * 2) return `in ${Math.round(secs / 3600)}h`;
  return `in ${Math.round(secs / 86400)}d`;
}

function stateLevel(state: string | null): StatusLevel {
  if (!state || state === 'OK') return 'good';
  if (state === 'running') return 'good';
  return /^WARNINGS/.test(state) ? 'warning' : 'serious';
}

function Snap({ snap, count }: { snap: BackupSnap | null; count?: number }) {
  if (!snap) return <span className="muted">none</span>;
  return (
    <span title={`${fmtDateTime(snap.time * 1000)}${snap.size ? ` · ${fmtBytes(snap.size)}` : ''}${count ? ` · ${count} kept` : ''}`}>
      {timeAgo(snap.time * 1000)}
      <span className="muted">{snap.encrypted ? ' · encrypted' : ' · not encrypted'}{snap.verified === 'ok' ? ' · verified' : ''}</span>
      {snap.verified === 'failed' && <> <StatusBadge level="critical">verify failed</StatusBadge></>}
    </span>
  );
}

const ITEM_LABEL: Record<OffsiteItem['state'], string> = {
  done: 'offsite',
  uploading: 'uploading now',
  sent: 'sent; run not finished',
  failed: 'failed',
  never: 'not uploaded yet',
};

function ItemChip({ item }: { item: OffsiteItem }) {
  const level: StatusLevel = item.state === 'done' ? 'good' : item.state === 'failed' ? 'serious' : 'warning';
  return (
    <span className="bk-item">
      <StatusBadge level={level}>
        <span title={item.run?.error ?? item.group}>{item.name}: {ITEM_LABEL[item.state]}{item.state === 'done' && item.snapshot ? ` ${timeAgo(item.snapshot.time * 1000)}` : ''}</span>
      </StatusBadge>
    </span>
  );
}

function Findings({ b }: { b: BackupsState }) {
  if (b.findings.length === 0) return <div className="bk-allgood"><StatusBadge level="good">Every guest and dataset is backed up on schedule, or left out for a recorded reason.</StatusBadge></div>;
  return (
    <ul className="bk-findings">
      {b.findings.map((f, i) => (
        <li key={i}>
          <StatusBadge level={f.level}>{f.text}</StatusBadge>
          {f.detail && <div className="muted bk-detail">{f.detail}</div>}
        </li>
      ))}
    </ul>
  );
}

function Running({ b, now }: { b: BackupsState; now: number }) {
  if (b.running.length === 0) return <Empty>Nothing running. The next job is in the schedule below.</Empty>;
  return (
    <div className="bk-running">
      {b.running.map((r, i) => {
        if (r.kind !== 'offsite') {
          return <div key={i} className="bk-run"><strong>{r.title}</strong> <span className="muted">{r.detail} · started {timeAgo(ms(r.startedAt))}</span></div>;
        }
        const itemStart = r.item?.startedAt ?? r.startedAt;
        const elapsed = r.progressAt && itemStart ? r.progressAt - itemStart : null;
        const rate = elapsed && r.processedBytes ? r.processedBytes / elapsed : null;
        const left = r.totalBytes && r.processedBytes != null ? Math.max(0, r.totalBytes - r.processedBytes) : null;
        return (
          <div key={i} className="bk-run">
            <div className="bk-run-head">
              <strong>{r.title}</strong>
              <span className="muted">running {fmtDuration((now / 1000) - (r.startedAt ?? now / 1000))} · since {fmtDateTime(ms(r.startedAt)!)}</span>
            </div>
            {r.item && (
              <>
                <div className="bk-run-item">
                  <span>{r.item.name} <span className="muted">{r.item.path}</span></span>
                  <span className="num">{r.processedBytes != null ? fmtBytes(r.processedBytes) : '—'}<span className="muted"> read{r.totalBytes ? ` of about ${fmtBytes(r.totalBytes)}` : ''}</span></span>
                </div>
                {r.totalBytes && r.processedBytes != null && <Meter value={r.processedBytes} max={r.totalBytes} color={SERIES[0]} label="read so far" />}
                <div className="muted bk-run-facts">
                  {r.uploadedBytes != null && <span>{fmtBytes(r.uploadedBytes)} uploaded (the client&rsquo;s count)</span>}
                  {rate && <span>{fmtBytes(rate)}/s average read</span>}
                  {rate && left != null && <span>about {fmtDuration(left / rate)} left at that pace</span>}
                  {r.progressAt && <span>progress logged {timeAgo(ms(r.progressAt))}</span>}
                </div>
              </>
            )}
            <div className="bk-run-facts">
              {(r.done ?? []).length > 0 && <span><span className="muted">done this run:</span> {r.done!.join(', ')}</span>}
              {(r.queued ?? []).length > 0 && <span><span className="muted">after this:</span> {r.queued!.join(', ')}</span>}
            </div>
            <p className="muted bk-note">Reading only costs upload when the data is new: files already in B2 (also under another name) are skipped, so the network can sit idle while this reads.</p>
          </div>
        );
      })}
    </div>
  );
}

function Schedule({ b, now }: { b: BackupsState; now: number }) {
  return (
    <table className="table">
      <thead><tr><th>Job</th><th>When</th><th>Next</th><th>Last run</th></tr></thead>
      <tbody>
        {b.schedule.map(j => (
          <tr key={j.id}>
            <td><strong>{j.title}</strong><div className="muted">{j.what}</div></td>
            <td>{j.schedule ?? '—'}{!j.enabled && <> <StatusBadge level="warning">disabled</StatusBadge></>}</td>
            <td>
              {j.nextRun ? <>{fmtDateTime(j.nextRun * 1000)} <span className="muted">{until(j.nextRun, now)}</span></> : <span className="muted">—</span>}
              {j.nextNote && <div className="muted bk-detail">{j.nextNote}</div>}
            </td>
            <td>
              {j.last ? (
                <>
                  <StatusBadge level={stateLevel(j.last.state)}>{j.last.state === 'running' ? 'running' : j.last.state ?? 'done'}</StatusBadge>
                  <div className="muted">
                    {j.last.end ? `ended ${timeAgo(j.last.end * 1000)}` : j.last.start ? `started ${timeAgo(j.last.start * 1000)}` : ''}
                    {j.last.start && j.last.end ? ` · took ${fmtDuration(j.last.end - j.last.start)}` : ''}
                  </div>
                </>
              ) : <span className="muted">never</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Coverage({ b }: { b: BackupsState }) {
  const rows = b.data.filter(d => d.coverage !== 'guest');
  const guestDisks = b.data.filter(d => d.coverage === 'guest');
  const order = { none: 0, partial: 1, offsite: 2, excluded: 3, empty: 4, guest: 5 } as const;
  rows.sort((a, c) => order[a.coverage] - order[c.coverage] || c.sizeBytes - a.sizeBytes);
  return (
    <>
      <table className="table">
        <thead><tr><th>Data</th><th className="num">Size</th><th>Offsite ({b.offsiteStore})</th><th>Local copy</th></tr></thead>
        <tbody>
          {rows.map(d => (
            <tr key={d.dataset} className={d.coverage === 'empty' || d.coverage === 'excluded' ? 'stopped' : ''}>
              <td><span className="mono">{d.path}</span>{d.note && <div className="muted bk-detail">{d.note}</div>}</td>
              <td className="num nowrap">{fmtBytes(d.sizeBytes)}</td>
              <td>
                {d.coverage === 'none' && <StatusBadge level="warning">no backup</StatusBadge>}
                {d.coverage === 'empty' && <span className="muted">empty</span>}
                {d.coverage === 'excluded' && <span className="muted">left out: {d.reason}</span>}
                {(d.coverage === 'offsite' || d.coverage === 'partial') && <div className="bk-items">{d.offsite.map(i => <ItemChip key={i.name} item={i} />)}</div>}
              </td>
              <td className="muted">
                {d.path === `/bulk/backups/pbs` ? 'is the local copy' : d.zfsSnapshotAt ? `ZFS snapshot ${timeAgo(d.zfsSnapshotAt)}` : 'no ZFS snapshots'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted bk-note">
        {guestDisks.length} guest disks ({fmtBytes(guestDisks.reduce((a, d) => a + d.sizeBytes, 0))}) go into their guest&rsquo;s backup below. Bind-mounted data is skipped by guest backups; the host offsite job sends it to B2 with no local PBS copy, so its only local protection is ZFS (RAIDZ2) and any snapshots.
      </p>
    </>
  );
}

function Guests({ b }: { b: BackupsState }) {
  return (
    <table className="table">
      <thead><tr><th className="num">ID</th><th>Guest</th><th>Local ({b.localStore})</th><th>Offsite ({b.offsiteStore})</th><th /></tr></thead>
      <tbody>
        {b.guests.map(g => (
          <tr key={g.vmid} className={g.status === 'running' ? '' : 'stopped'}>
            <td className="num muted">{g.vmid}</td>
            <td>{g.name}<span className="type-tag">{g.type === 'vm' ? 'VM' : 'LXC'}</span></td>
            <td><Snap snap={g.local} count={g.localCount} /></td>
            <td><Snap snap={g.offsite} count={g.offsiteCount} /></td>
            <td>{g.problems.length ? g.problems.map((p, i) => <StatusBadge key={i} level={p.level}>{p.text}</StatusBadge>) : <StatusBadge level="good">ok</StatusBadge>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Datastores({ b }: { b: BackupsState }) {
  return (
    <div className="bk-stores">
      {b.datastores.map(d => (
        <div key={d.store} className="bk-store">
          <strong>{d.store}</strong> <span className="muted">{d.backend === 's3' ? 'Backblaze B2 (S3)' : 'local disk'}{d.comment ? ` · ${d.comment}` : ''}</span>
          {d.used != null && d.total != null && (
            <>
              <Meter value={d.used} max={d.total} color={SERIES[0]} />
              <div className="muted">
                {d.backend === 's3'
                  ? `local cache ${fmtBytes(d.used)} of ${fmtBytes(d.total)} (what's in the bucket isn't reported here)`
                  : `${fmtBytes(d.used)} of ${fmtBytes(d.total)}${d.estimatedFull ? ` · full around ${new Date(d.estimatedFull * 1000).toLocaleDateString([], { month: 'short', year: 'numeric' })} at this rate` : ''}`}
              </div>
            </>
          )}
          {d.error && <StatusBadge level="warning">{d.error}</StatusBadge>}
        </div>
      ))}
    </div>
  );
}

export function BackupsView({ state }: { state: DashboardState }) {
  const now = useNow();
  const b = state.backups;
  const fresh = <Freshness collector={state.collectors.backups} />;
  if (!b) return <div className="view"><Panel title="Backups" aside={fresh}><Empty>Waiting for the first backups collection (every 2 minutes).</Empty></Panel></div>;
  return (
    <div className="view">
      <Panel title="Backups" aside={fresh}>
        <Findings b={b} />
      </Panel>
      <Panel title="Running now"><Running b={b} now={now} /></Panel>
      <Panel title="Schedule"><Schedule b={b} now={now} /></Panel>
      <Panel title="Data"><Coverage b={b} /></Panel>
      <Panel title="Guests"><Guests b={b} /></Panel>
      <Panel title="Datastores">
        <Datastores b={b} />
        <p className="muted bk-note">PBS read {b.pbsVia === 'api' ? 'through its API' : <>over SSH. Run <span className="mono">ops/guests/119-onas/create-pbs-token</span> to give onas a read-only API token instead.</>}</p>
      </Panel>
    </div>
  );
}
