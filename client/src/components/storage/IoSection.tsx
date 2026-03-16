const HISTORY_LEN = 60;

interface IoPoint {
  readBytes: number;
  writeBytes: number;
  readOps: number;
  writeOps: number;
}

function fmtBps(bytes: number) {
  if (bytes === 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024));
  return (bytes / 1024 ** i).toFixed(i > 1 ? 1 : 0) + ' ' + units[Math.min(i, units.length - 1)];
}

function fmtOps(n: number) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }

function IoCard({ pool, history }: { pool: string; history: IoPoint[] }) {
  const latest = history[history.length - 1] ?? { readBytes: 0, writeBytes: 0, readOps: 0, writeOps: 0 };
  const writeColor = pool === 'fast' ? 'var(--cyan)' : 'var(--amber)';
  const readHistory = history.map(h => h.readBytes);
  const writeHistory = history.map(h => h.writeBytes);
  const maxVal = Math.max(...readHistory, ...writeHistory, 1);
  const stale = history.length === 0;

  return (
    <div className={`io-card ${pool}`}>
      <div className="io-card-header">
        <span className={`io-pool-name ${pool}`}>{pool}</span>
        <div className="io-live-dot">
          <span className={`live-dot ${stale ? 'stale' : ''}`} />
          LIVE
        </div>
      </div>
      <div className="io-metrics">
        <div className="io-metric">
          <div className="io-metric-label">Read</div>
          <div className="io-metric-value read">{fmtBps(latest.readBytes)}</div>
          <div className="io-metric-sub">{fmtOps(latest.readOps)} ops/s</div>
        </div>
        <div className="io-metric">
          <div className="io-metric-label">Write</div>
          <div className={`io-metric-value write ${pool}`}>{fmtBps(latest.writeBytes)}</div>
          <div className="io-metric-sub">{fmtOps(latest.writeOps)} ops/s</div>
        </div>
      </div>
      <div className="io-chart">
        <div className="io-chart-labels">
          <span style={{ color: 'var(--green)' }}>▲ read</span>
          <span style={{ color: writeColor }}>▲ write</span>
          <span>{fmtBps(maxVal)} peak</span>
        </div>
        <svg viewBox="0 0 400 56" preserveAspectRatio="none" style={{ height: 56, display: 'block', width: '100%' }}>
          <defs>
            <linearGradient id={`rgrad-${pool}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--green)" stopOpacity="0.2" />
              <stop offset="100%" stopColor="var(--green)" stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id={`wgrad-${pool}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={writeColor} stopOpacity="0.2" />
              <stop offset="100%" stopColor={writeColor} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {[readHistory, writeHistory].map((hist, ci) => {
            if (hist.length < 2) return null;
            const color = ci === 0 ? 'var(--green)' : writeColor;
            const gradId = ci === 0 ? `rgrad-${pool}` : `wgrad-${pool}`;
            const W = 400; const H = 56; const pad = 2;
            const pts = hist.map((v, i) => {
              const x = pad + (i / (HISTORY_LEN - 1)) * (W - pad * 2);
              const y = H - pad - (v / maxVal) * (H - pad * 2);
              return [x, y] as [number, number];
            });
            const ptsStr = pts.map(p => p.join(',')).join(' L');
            const first = pts[0]; const last = pts[pts.length - 1];
            return (
              <g key={ci}>
                <path d={`M${first[0]},${H} L${ptsStr} L${last[0]},${H} Z`} fill={`url(#${gradId})`} />
                <path d={`M${ptsStr}`} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
                <circle cx={last[0]} cy={last[1]} r="2.5" fill={color} />
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

export function IoSection({ ioHistory }: { ioHistory: Record<string, IoPoint[]> }) {
  const pools = Object.keys(ioHistory);
  if (pools.length === 0) {
    return (
      <div className="io-grid">
        {['bulk', 'fast'].map(p => <IoCard key={p} pool={p} history={[]} />)}
      </div>
    );
  }
  return (
    <div className="io-grid">
      {pools.map(p => <IoCard key={p} pool={p} history={ioHistory[p]} />)}
    </div>
  );
}

export { HISTORY_LEN };
