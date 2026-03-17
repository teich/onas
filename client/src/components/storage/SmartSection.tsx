import type { SmartDisk } from '../../lib/types';

function fmtHours(h: number | null): string {
  if (h === null) return '—';
  if (h >= 8760) return (h / 8760).toFixed(1) + 'y';
  if (h >= 1000) return (h / 1000).toFixed(1) + 'k h';
  return h + ' h';
}

function TempCell({ tempC }: { tempC: number | null }) {
  if (tempC === null) return <span style={{ color: 'var(--text2)' }}>—</span>;
  const cls = tempC > 55 ? 'smart-temp-hot' : tempC > 40 ? 'smart-temp-warn' : 'smart-temp-ok';
  return <span className={cls} style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{tempC}°C</span>;
}

function HealthCell({ disk }: { disk: SmartDisk }) {
  if (disk.error) {
    return <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text2)' }}>error</span>;
  }
  if (disk.healthPassed === null) {
    return <span style={{ color: 'var(--text2)', fontFamily: 'var(--mono)', fontSize: 10 }}>—</span>;
  }
  return (
    <span className={disk.healthPassed ? 'smart-health-passed' : 'smart-health-failed'}>
      {disk.healthPassed ? 'PASSED' : 'FAILED'}
    </span>
  );
}

function ReallocCell({ n }: { n: number | null }) {
  if (n === null) return <span style={{ color: 'var(--text2)' }}>—</span>;
  if (n === 0) return <span className="smart-realloc-ok">0</span>;
  return <span className="smart-realloc-bad">⚠ {n}</span>;
}

interface SmartSectionProps {
  disks: SmartDisk[];
  loading: boolean;
  error: string | null;
}

export function SmartSection({ disks, loading, error }: SmartSectionProps) {
  if (loading) {
    return (
      <div className="datasets-table">
        {[0, 1, 2].map(i => (
          <div key={i} style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
            <div className="shimmer" style={{ height: 14, width: `${60 + i * 10}%` }} />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-banner">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.4" />
          <path d="M7 4v3M7 9.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        SMART error: {error}
      </div>
    );
  }

  if (disks.length === 0) {
    return <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text2)', padding: '16px 0' }}>No disks found.</p>;
  }

  return (
    <div className="datasets-table">
      <div className="smart-table-head">
        <span className="th">Device</span>
        <span className="th">Model</span>
        <span className="th">Type</span>
        <span className="th">Temp</span>
        <span className="th">Health</span>
        <span className="th">Hours</span>
        <span className="th">Reallocated</span>
      </div>
      {disks.map((disk, i) => (
        <div key={i} className="smart-table-row">
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text1)' }}>
            {disk.device}
          </span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {disk.model}
          </span>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 9, padding: '2px 5px', borderRadius: 3,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            color: disk.type === 'nvme' ? 'var(--cyan)' : 'var(--amber)',
            background: disk.type === 'nvme' ? 'var(--cyan-dim)' : 'var(--amber-dim)',
          }}>
            {disk.type}
          </span>
          <TempCell tempC={disk.tempC} />
          <HealthCell disk={disk} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)' }}>
            {fmtHours(disk.powerOnHours)}
          </span>
          <ReallocCell n={disk.reallocatedSectors} />
        </div>
      ))}
    </div>
  );
}
