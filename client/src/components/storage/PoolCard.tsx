import type { Pool, Vdev } from '../../lib/types';

function getHealthClass(h = '') {
  const v = h.toLowerCase();
  if (v === 'online') return 'online';
  if (v === 'degraded') return 'degraded';
  return 'faulted';
}

function shortDiskName(name: string) {
  const m = name.match(/ata-([^_]+_[^_]+)_(.*)/);
  if (m) return m[1].replace(/_/g, ' ');
  const nv = name.match(/nvme-(.+?)_(\d+GB)/);
  if (nv) return `${nv[1].replace(/_/g, ' ')} ${nv[2]}`;
  return name.length > 28 ? name.slice(0, 26) + '…' : name;
}

function diskType(name: string) { return name.startsWith('nvme-') ? 'nvme' : 'ata'; }

function vdevTypeLabel(name: string) {
  if (name.startsWith('raidz2')) return 'RAIDZ2';
  if (name.startsWith('raidz')) return 'RAIDZ';
  if (name.startsWith('mirror')) return 'MIRROR';
  return 'STRIPE';
}

function vdevTypeClass(name: string) {
  if (name.startsWith('raidz2')) return 'vdev-type-raidz2';
  if (name.startsWith('mirror')) return 'vdev-type-mirror';
  return '';
}

function StatBox({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-box">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function UsageBar({ pct }: { pct: number; poolName: string }) {
  return (
    <div>
      <div className="usage-labels">
        <span className="usage-label-left">Storage used</span>
        <span className="usage-pct">{pct}%</span>
      </div>
      <div className="usage-track">
        <div className="usage-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  );
}

function VdevTopology({ vdevs }: { vdevs: Vdev[] }) {
  if (!vdevs?.length) return null;
  return (
    <div className="vdev-section">
      <div className="vdev-title">Disk topology</div>
      {vdevs.map((vdev, i) => (
        <div key={i} className="vdev-group">
          <div className="vdev-group-header">
            <span className="vdev-group-name">{vdev.name}</span>
            <span className={`vdev-group-type ${vdevTypeClass(vdev.name)}`}>{vdevTypeLabel(vdev.name)}</span>
          </div>
          <div className="vdev-disks">
            {(vdev.children.length ? vdev.children : [vdev]).map((disk, j) => (
              <div key={j} className="disk-chip">
                <span className={`disk-chip-dot ${getHealthClass(disk.state)}`} />
                <span className={`disk-name disk-type-${diskType(disk.name)}`}>{shortDiskName(disk.name)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ScanInfo({ scan }: { scan: string }) {
  if (!scan) return null;
  const html = scan.replace(/(0 errors|\d+ errors)/g, m =>
    m.includes('0') ? `<span>${m}</span>` : `<span style="color:var(--red)">${m}</span>`
  );
  return (
    <div className="scan-info">
      <div className="stat-label">Last scrub</div>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export function PoolCard({ pool }: { pool: Pool }) {
  return (
    <div className={`pool-card pool-${pool.name} fade-in`}>
      <div className="pool-header">
        <div className="pool-name-row">
          <div className="pool-name">{pool.name}</div>
          <div className="pool-type-tag">{pool.vdevs?.[0] ? vdevTypeLabel(pool.vdevs[0].name) : 'ZFS'}</div>
        </div>
        <div className="pool-health">
          <span className={`health-dot ${getHealthClass(pool.health)}`} />
          <span className={`health-label ${getHealthClass(pool.health)}`}>{pool.health}</span>
        </div>
      </div>
      <div className="pool-body">
        <div className="pool-stats-row">
          <StatBox label="Total" value={pool.size} />
          <StatBox label="Used" value={pool.alloc} />
          <StatBox label="Free" value={pool.free} sub={`Frag: ${pool.frag}`} />
        </div>
        <UsageBar pct={pool.cap} poolName={pool.name} />
        {pool.vdevs && <VdevTopology vdevs={pool.vdevs} />}
        {pool.scan && <ScanInfo scan={pool.scan} />}
      </div>
    </div>
  );
}
