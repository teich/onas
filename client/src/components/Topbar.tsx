export type View = 'storage' | 'shares' | 'users' | 'host';

interface TopbarProps {
  view: View;
  setView: (v: View) => void;
  timestamp: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}

export function Topbar({ view, setView, timestamp, refreshing, onRefresh }: TopbarProps) {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="logo">NAS<span>//</span>CTRL</div>
        <div className="topbar-host">192.168.2.2</div>
        <nav className="nav-tabs">
          <button className={`nav-tab ${view === 'storage' ? 'active' : ''}`} onClick={() => setView('storage')}>Storage</button>
          <button className={`nav-tab ${view === 'host' ? 'active' : ''}`} onClick={() => setView('host')}>Host</button>
          <button className={`nav-tab ${view === 'shares' ? 'active' : ''}`} onClick={() => setView('shares')}>Shares</button>
          <button className={`nav-tab ${view === 'users' ? 'active' : ''}`} onClick={() => setView('users')}>Users</button>
        </nav>
      </div>
      <div className="topbar-right">
        {timestamp && <div className="timestamp">Updated {fmt(timestamp)}</div>}
        <button className={`refresh-btn ${refreshing ? 'spinning' : ''}`} onClick={onRefresh}>
          <svg className="icon-refresh" width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ display: 'inline-block' }}>
            <path d="M10.5 6A4.5 4.5 0 112.25 3.5M10.5 1v2.5H8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Refresh
        </button>
      </div>
    </header>
  );
}
