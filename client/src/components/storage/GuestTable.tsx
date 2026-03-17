import type { Guest, Dataset } from '../../lib/types';
import { parseSize } from '../../lib/helpers';

// Match fast/subvol-{vmid}-disk-{n} or fast/vm-{vmid}-disk-{n}
function parseGuestDataset(name: string): { vmid: number; diskIndex: number; type: 'lxc' | 'vm' } | null {
  const m = name.match(/^fast\/(subvol|vm)-(\d+)-disk-(\d+)$/);
  if (!m) return null;
  return { type: m[1] === 'subvol' ? 'lxc' : 'vm', vmid: parseInt(m[2]), diskIndex: parseInt(m[3]) };
}

export function isGuestDataset(name: string): boolean {
  return parseGuestDataset(name) !== null;
}

interface GuestDisk {
  dataset: Dataset;
  diskIndex: number;
}

interface GuestRow {
  vmid: number;
  type: 'lxc' | 'vm';
  name: string;
  status: string;
  disks: GuestDisk[];
}

function StatusDot({ status }: { status: string }) {
  const running = status === 'running';
  return (
    <span
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: running ? 'var(--green)' : 'var(--text2)',
        flexShrink: 0,
        boxShadow: running ? '0 0 6px var(--green)' : 'none',
      }}
    />
  );
}

function TypeBadge({ type }: { type: 'lxc' | 'vm' }) {
  return (
    <span style={{
      fontSize: 9,
      fontFamily: 'var(--mono)',
      padding: '2px 5px',
      borderRadius: 3,
      letterSpacing: '0.08em',
      textTransform: 'uppercase' as const,
      color: type === 'lxc' ? 'var(--cyan)' : 'var(--amber)',
      background: type === 'lxc' ? 'var(--cyan-dim)' : 'var(--amber-dim)',
      flexShrink: 0,
    }}>
      {type}
    </span>
  );
}

function DiskBar({ ds }: { ds: Dataset }) {
  const isVol = ds.type === 'volume';
  const used = parseSize(ds.used);
  const avail = parseSize(ds.avail);
  const total = used + avail;
  const pct = !isVol && total > 0 ? Math.min((used / total) * 100, 100) : null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {pct !== null && (
        <div className="size-mini-bar" style={{ width: 36 }}>
          <div className="size-mini-fill fast-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text1)', minWidth: 36 }}>
        {ds.used}
      </span>
      {pct !== null && (
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text2)' }}>
          / {ds.avail} free
        </span>
      )}
    </div>
  );
}

function GuestRowEl({ row }: { row: GuestRow }) {
  const allVols = row.disks.every(d => d.dataset.type === 'volume');
  const totalUsed = row.disks.reduce((s, d) => s + parseSize(d.dataset.used), 0);
  const totalAvail = allVols ? 0 : row.disks.reduce((s, d) => s + parseSize(d.dataset.avail), 0);
  const totalBytes = totalUsed + totalAvail;
  const pct = !allVols && totalBytes > 0 ? Math.min((totalUsed / totalBytes) * 100, 100) : null;

  function fmtGb(bytes: number) {
    return (bytes / 1024 ** 3).toFixed(1) + 'G';
  }

  return (
    <div style={{
      borderBottom: '1px solid var(--border)',
      padding: '10px 16px',
    }}>
      {/* Guest header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: row.disks.length > 1 ? 8 : 0 }}>
        <StatusDot status={row.status} />
        <TypeBadge type={row.type} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text2)', minWidth: 28 }}>
          {row.vmid}
        </span>
        <span style={{ fontWeight: 500, fontSize: 13, color: 'var(--text0)', flex: 1 }}>
          {row.name}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text2)', marginRight: 8 }}>
          {row.disks.length} {row.disks.length === 1 ? 'disk' : 'disks'}
        </span>
        {/* Total usage bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {pct !== null && (
            <div className="size-mini-bar" style={{ width: 52 }}>
              <div className="size-mini-fill fast-fill" style={{ width: `${pct}%` }} />
            </div>
          )}
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text1)', minWidth: 44 }}>
            {fmtGb(totalUsed)}
          </span>
          {pct !== null && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text2)', minWidth: 70 }}>
              {pct.toFixed(0)}% · {fmtGb(totalAvail)} free
            </span>
          )}
        </div>
      </div>

      {/* Per-disk breakdown (only if multiple disks) */}
      {row.disks.length > 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 27 }}>
          {row.disks.map(d => (
            <div key={d.diskIndex} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text2)', minWidth: 42 }}>
                disk-{d.diskIndex}
              </span>
              <DiskBar ds={d.dataset} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface GuestTableProps {
  guests: Guest[];
  datasets: Dataset[];
}

export function GuestTable({ guests, datasets }: GuestTableProps) {
  // Build guest rows by grouping datasets by vmid
  const byVmid = new Map<number, GuestDisk[]>();
  for (const ds of datasets) {
    const parsed = parseGuestDataset(ds.name);
    if (!parsed) continue;
    if (!byVmid.has(parsed.vmid)) byVmid.set(parsed.vmid, []);
    byVmid.get(parsed.vmid)!.push({ dataset: ds, diskIndex: parsed.diskIndex });
  }

  const guestMap = new Map(guests.map(g => [g.vmid, g]));

  const rows: GuestRow[] = [];
  for (const [vmid, disks] of byVmid) {
    const g = guestMap.get(vmid);
    disks.sort((a, b) => a.diskIndex - b.diskIndex);
    rows.push({
      vmid,
      type: g?.type ?? (disks[0].dataset.name.includes('/subvol-') ? 'lxc' : 'vm'),
      name: g?.name ?? `guest-${vmid}`,
      status: g?.status ?? 'unknown',
      disks,
    });
  }

  rows.sort((a, b) => a.vmid - b.vmid);

  if (rows.length === 0) return null;

  return (
    <div className="datasets-table" style={{ marginTop: 0 }}>
      <div className="table-head" style={{ display: 'flex', alignItems: 'center', padding: '8px 16px', gap: 10 }}>
        <span className="th" style={{ flex: 1 }}>Guest</span>
        <span className="th">Storage</span>
      </div>
      {rows.map(row => <GuestRowEl key={row.vmid} row={row} />)}
    </div>
  );
}
