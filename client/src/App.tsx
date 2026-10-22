import { useEffect, useState } from 'react';
import { subscribeState } from './lib/api';
import type { DashboardState } from './lib/types';
import { fmtBytes, fmtDuration, fmtPct } from './lib/format';
import { StatusBadge } from './components/ui';
import { StorageView } from './views/StorageView';
import { SharesView } from './views/SharesView';
import { SnapshotsView } from './views/SnapshotsView';
import { GuestsView } from './views/GuestsView';
import { ActivityView } from './views/ActivityView';

const TABS = [
  { id: 'storage', label: 'Storage' },
  { id: 'shares', label: 'Shares' },
  { id: 'snapshots', label: 'Snapshots' },
  { id: 'guests', label: 'Guests' },
  { id: 'activity', label: 'Activity' },
] as const;
type Tab = (typeof TABS)[number]['id'];

// The route is the hash: #/shares, #/snapshots?dataset=bulk/photos ...
function readRoute(): { tab: Tab; params: URLSearchParams } {
  const [path, query = ''] = window.location.hash.replace(/^#\/?/, '').split('?');
  const tab = (TABS.find(t => t.id === path)?.id ?? 'storage') as Tab;
  return { tab, params: new URLSearchParams(query) };
}

export function navigate(tab: Tab, params: Record<string, string> = {}) {
  const q = new URLSearchParams(params).toString();
  window.location.hash = `/${tab}${q ? `?${q}` : ''}`;
}

function HostStrip({ state, connected }: { state: DashboardState; connected: boolean }) {
  const h = state.host;
  const failing = Object.entries(state.collectors).filter(([, c]) => c.ok === false);
  const memPct = h ? h.mem.usedBytes / Math.max(1, h.mem.totalBytes) : 0;
  return (
    <div className="host-strip">
      <span className="host-name"><strong>{h?.hostname ?? 'wtr'}</strong><span className="muted">{h?.pveVersion?.replace('pve-manager/', 'PVE ').split('/')[0]}</span></span>
      {h && (
        <>
          <span className="host-stat"><span className="muted">CPU</span>{fmtPct(h.cpu.pct / 100)}<span className="muted">of {h.cpu.cores}</span></span>
          <span className="host-stat"><span className="muted">Memory</span>{fmtBytes(h.mem.usedBytes)}<span className="muted">{fmtPct(memPct)}</span></span>
          <span className="host-stat"><span className="muted">Load</span>{h.load.load1.toFixed(2)}</span>
          <span className="host-stat"><span className="muted">Up</span>{fmtDuration(h.uptimeSeconds)}</span>
        </>
      )}
      <span className="host-spacer" />
      {state.updates.count > 0
        ? <StatusBadge level="warning"><span title={state.updates.packages.map(p => `${p.package} ${p.oldVersion} → ${p.version}`).join('\n')}>{state.updates.count} host updates</span></StatusBadge>
        : <span className="muted">host packages current</span>}
      {!connected
        ? <StatusBadge level="critical">disconnected</StatusBadge>
        : failing.length
          ? <StatusBadge level="warning"><span title={failing.map(([n, c]) => `${n}: ${c.error}`).join('\n')}>{failing.map(([n]) => n).join(', ')} failing</span></StatusBadge>
          : <StatusBadge level="good">live</StatusBadge>}
    </div>
  );
}

export function App() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [connected, setConnected] = useState(true);
  const [route, setRoute] = useState(readRoute);

  useEffect(() => subscribeState(setState, setConnected), []);
  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/storage">onas</a>
        <nav className="tabs">
          {TABS.map(t => (
            <a key={t.id} href={`#/${t.id}`} className={route.tab === t.id ? 'on' : ''}>{t.label}</a>
          ))}
        </nav>
      </header>
      {state ? <HostStrip state={state} connected={connected} /> : <div className="host-strip"><span className="muted">{connected ? 'Loading…' : 'Can’t reach onas, retrying…'}</span></div>}
      <main className="content">
        {!state ? <div className="skeleton-page"><div /><div /><div /></div> : (
          <>
            {route.tab === 'storage' && <StorageView state={state} />}
            {route.tab === 'shares' && <SharesView state={state} params={route.params} />}
            {route.tab === 'snapshots' && <SnapshotsView state={state} params={route.params} />}
            {route.tab === 'guests' && <GuestsView state={state} />}
            {route.tab === 'activity' && <ActivityView state={state} />}
          </>
        )}
      </main>
    </div>
  );
}
