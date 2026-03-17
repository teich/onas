import type { HostHealth } from '../../lib/types';

function fmtBytes(b: number): string {
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' GB';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + ' MB';
  return (b / 1024).toFixed(1) + ' KB';
}

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function UsageBar({ pct }: { pct: number }) {
  const color = pct > 85 ? 'var(--red)' : pct > 60 ? 'var(--amber)' : 'var(--green)';
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ height: 4, background: 'var(--bg3)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, borderRadius: 2, background: color, transition: 'width 0.8s cubic-bezier(0.4,0,0.2,1)', boxShadow: `0 0 8px ${color}` }} />
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, pct, accentColor }: {
  label: string;
  value: string;
  sub?: string;
  pct?: number;
  accentColor?: string;
}) {
  return (
    <div className="stat-box">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={accentColor ? { color: accentColor } : {}}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
      {pct !== undefined && <UsageBar pct={pct} />}
    </div>
  );
}

function LoadBox({ label, value, cores }: { label: string; value: number; cores: number }) {
  const rel = value / cores; // normalized to core count
  const color = rel > 1 ? 'var(--red)' : rel > 0.7 ? 'var(--amber)' : 'var(--text1)';
  return (
    <div className="host-load-box">
      <div className="stat-label">{label}</div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 500, color, marginTop: 4 }}>
        {value.toFixed(2)}
      </div>
    </div>
  );
}

interface HostViewProps {
  data: HostHealth | null;
}

export function HostView({ data }: HostViewProps) {
  if (!data) {
    return (
      <div className="main-body">
        <div className="content-area">
          <section>
            <div className="section-header">
              <div className="section-title">Node Health</div>
              <div className="section-line" />
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div className="live-dot stale" />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text2)' }}>connecting…</span>
              </div>
            </div>
            <div className="host-grid">
              {[0, 1, 2, 3].map(i => (
                <div key={i} className="skeleton-card" style={{ height: 80 }}>
                  <div className="shimmer" style={{ width: '40%', height: 12 }} />
                  <div className="shimmer" style={{ width: '60%', height: 24 }} />
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    );
  }

  const cpuPct = data.cpu.pct;
  const ramPct = (data.mem.usedBytes / data.mem.totalBytes) * 100;
  const swapPct = data.swap.totalBytes > 0 ? (data.swap.usedBytes / data.swap.totalBytes) * 100 : 0;
  const cpuColor = cpuPct > 85 ? 'var(--red)' : cpuPct > 60 ? 'var(--amber)' : 'var(--green)';
  const ramColor = ramPct > 90 ? 'var(--red)' : ramPct > 70 ? 'var(--amber)' : 'var(--text0)';

  return (
    <div className="main-body">
      <div className="content-area">
        <section>
          <div className="section-header">
            <div className="section-title">Node Health</div>
            <div className="section-line" />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div className="live-dot" />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text2)', letterSpacing: '0.08em' }}>5s live</span>
            </div>
          </div>

          <div className="host-grid">
            <StatCard
              label={`CPU · ${data.cpu.cores} cores`}
              value={`${cpuPct.toFixed(1)}%`}
              sub="utilisation"
              pct={cpuPct}
              accentColor={cpuColor}
            />
            <StatCard
              label="Memory"
              value={fmtBytes(data.mem.usedBytes)}
              sub={`of ${fmtBytes(data.mem.totalBytes)} · ${ramPct.toFixed(1)}% used`}
              pct={ramPct}
              accentColor={ramColor}
            />
            <StatCard
              label="Uptime"
              value={fmtUptime(data.uptimeSeconds)}
              sub="continuous"
            />
            {data.swap.totalBytes > 0 && (
              <StatCard
                label="Swap"
                value={fmtBytes(data.swap.usedBytes)}
                sub={`of ${fmtBytes(data.swap.totalBytes)}`}
                pct={swapPct}
                accentColor={swapPct > 50 ? 'var(--amber)' : 'var(--text1)'}
              />
            )}
          </div>
        </section>

        <section>
          <div className="section-header">
            <div className="section-title">Load Average</div>
            <div className="section-line" />
            <div className="section-title">{data.cpu.cores} cores</div>
          </div>
          <div className="host-load-grid">
            <LoadBox label="1 min" value={data.load.load1} cores={data.cpu.cores} />
            <LoadBox label="5 min" value={data.load.load5} cores={data.cpu.cores} />
            <LoadBox label="15 min" value={data.load.load15} cores={data.cpu.cores} />
          </div>
        </section>

        <section>
          <div className="section-header">
            <div className="section-title">Memory Detail</div>
            <div className="section-line" />
          </div>
          <div className="host-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
            <StatCard label="Used" value={fmtBytes(data.mem.usedBytes)} />
            <StatCard label="Available" value={fmtBytes(data.mem.availBytes)} />
            <StatCard label="Total" value={fmtBytes(data.mem.totalBytes)} />
          </div>
        </section>
      </div>
    </div>
  );
}
