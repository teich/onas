import type { DashboardState } from '../lib/types';
import { Empty, Panel, StatusBadge } from '../components/ui';
import { fmtDateTime, timeAgo } from '../lib/format';

export function ActivityView({ state }: { state: DashboardState }) {
  const collectors = Object.entries(state.collectors);
  return (
    <div className="view">
      <Panel title="Changes made through onas">
        {state.activity.length === 0 ? <Empty>Nothing yet. Every share edit, snapshot and guest action shows up here.</Empty> : (
          <div className="activity">
            {state.activity.map(a => (
              <details key={a.id}>
                <summary>
                  {a.ok ? <StatusBadge level="good">ok</StatusBadge> : <StatusBadge level="critical">failed</StatusBadge>}
                  <span className="act-what"><strong>{a.action}</strong> {a.target}</span>
                  <span className="muted">{fmtDateTime(a.timestamp)} · {timeAgo(a.timestamp)} · {a.actor}</span>
                </summary>
                <pre>{a.output || (a.ok ? 'ok' : `exit ${a.exitCode}`)}</pre>
              </details>
            ))}
          </div>
        )}
      </Panel>
      <Panel title="Collectors">
        <table className="table">
          <thead><tr><th>Collector</th><th>Every</th><th>Last good run</th><th className="num">Took</th><th>Via</th><th>Status</th></tr></thead>
          <tbody>
            {collectors.map(([name, c]) => (
              <tr key={name}>
                <td><strong>{name}</strong></td>
                <td>{c.intervalMs >= 60_000 ? `${c.intervalMs / 60_000} min` : `${c.intervalMs / 1000} s`}</td>
                <td>{c.lastOk ? timeAgo(c.lastOk) : 'never'}</td>
                <td className="num">{c.durationMs != null ? `${c.durationMs} ms` : '—'}</td>
                <td className="muted">{c.via ?? '—'}</td>
                <td>{c.ok === false ? <StatusBadge level="critical"><span title={c.error ?? ''}>{(c.error ?? 'failed').slice(0, 80)}</span></StatusBadge> : c.ok ? <StatusBadge level="good">ok</StatusBadge> : <span className="muted">pending</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
