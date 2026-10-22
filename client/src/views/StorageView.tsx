import { useMemo, useState } from 'react';
import type { DashboardState, Dataset, Disk, HardwareState, Pool, Vdev } from '../lib/types';
import { buildStorageModel, isGuestDisk, poolOf, SELF_VMID, type StorageModel } from '../lib/storageModel';
import { StorageMap, type MapLayout, type MapTarget } from '../viz/StorageMap';
import { Freshness, Meter, Panel, StatusBadge } from '../components/ui';
import { fmtBytes, fmtRate, timeAgo } from '../lib/format';
import { poolColor, type StatusLevel } from '../lib/palette';
import { diskFor, diskLevel, slotName } from '../lib/diskHealth';
import { navigate } from '../App';

function scrubInfo(scan: string): { text: string; level: StatusLevel } {
  const m = scan.match(/on (\w{3} \w{3} +\d+ [\d:]+ \d{4})/);
  if (/in progress/.test(scan)) return { text: 'scrub running', level: 'good' };
  if (!m) return { text: scan || 'never scrubbed', level: 'warning' };
  const at = new Date(m[1]).getTime();
  const days = (Date.now() - at) / 86400_000;
  const errs = /with (\d+) errors/.exec(scan)?.[1] ?? '0';
  return { text: `scrubbed ${timeAgo(at)}${errs !== '0' ? `, ${errs} errors` : ''}`, level: errs !== '0' ? 'critical' : days > 40 ? 'warning' : 'good' };
}

function PoolTile({ pool }: { pool: Pool }) {
  const scrub = scrubInfo(pool.scan);
  const healthy = pool.health === 'ONLINE';
  return (
    <div className="pool-tile" style={{ '--pool': poolColor(pool.name) } as React.CSSProperties}>
      <div className="pool-tile-head">
        <span className="pool-name"><i className="swatch" style={{ background: poolColor(pool.name) }} />{pool.name}</span>
        <StatusBadge level={healthy ? 'good' : 'critical'}>{pool.health.toLowerCase()}</StatusBadge>
      </div>
      <div className="hero-number">{Math.round((pool.alloc / pool.size) * 100)}<span>% used</span></div>
      <Meter value={pool.alloc} max={pool.size} color={poolColor(pool.name)} label={`${fmtBytes(pool.alloc)} of ${fmtBytes(pool.size)}`} />
      <div className="pool-tile-facts">
        <span>{fmtBytes(pool.free)} free of {fmtBytes(pool.size)}</span>
        <span>{pool.frag}% fragmented</span>
        <StatusBadge level={scrub.level}>{scrub.text}</StatusBadge>
      </div>
      {pool.errors && pool.errors !== 'No known data errors' && <StatusBadge level="critical">{pool.errors}</StatusBadge>}
    </div>
  );
}

function DiskTile({ disk, slot }: { disk: Disk | undefined; name: string; slot: string | null }) {
  if (!disk) return <div className="disk-tile unknown"><span className="muted">unknown disk</span></div>;
  const { level, note } = diskLevel(disk);
  const years = disk.powerOnHours != null ? disk.powerOnHours / 8766 : null;
  return (
    <div className={`disk-tile level-${level}`}>
      <div className="disk-dev">
        <span className="disk-dev-name">{disk.devpath.replace('/dev/', '')}{slot && <a className="slot-chip" href={`#/machine?slot=${slot}`} title="Show this drive in the Machine view">{slotName(slot)}</a>}</span>
        <StatusBadge level={level}>{note}</StatusBadge>
      </div>
      <div className="disk-model" title={`${disk.model} · ${disk.serial}`}>{disk.model}</div>
      <div className="disk-facts">
        <span>{fmtBytes(disk.size, 0)}</span>
        {disk.tempC != null && <span>{disk.tempC}°C</span>}
        {years != null && <span>{years.toFixed(1)} yr on</span>}
        {disk.type === 'nvme' && disk.wearout != null && <span>{disk.wearout}% life left</span>}
      </div>
    </div>
  );
}

function PoolLayout({ pool, disks, hardware }: { pool: Pool; disks: Disk[]; hardware: HardwareState | null }) {
  const groups: Vdev[] = pool.vdevs.length && pool.vdevs.every(v => v.leaf) ? [{ name: 'stripe', state: pool.health, read: 0, write: 0, cksum: 0, leaf: 0, children: pool.vdevs }] : pool.vdevs;
  return (
    <div className="pool-layout">
      <div className="pool-layout-head"><i className="swatch" style={{ background: poolColor(pool.name) }} />{pool.name}</div>
      {groups.map(v => (
        <div key={v.name} className="vdev">
          <div className="vdev-name">{v.name.replace(/-\d+$/, '')} <span className="muted">{v.state.toLowerCase()}{v.read + v.write + v.cksum > 0 ? ` · ${v.read}/${v.write}/${v.cksum} errors` : ''}</span></div>
          <div className="disk-grid">
            {(v.children ?? []).map(leaf => {
              const disk = diskFor(disks, leaf.name);
              const slot = disk ? hardware?.disks.find(h => (h.serial && h.serial === disk.serial) || `/dev/${h.name}` === disk.devpath)?.slot ?? null : null;
              return <DiskTile key={leaf.name} name={leaf.name} disk={disk} slot={slot} />;
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function usersOf(state: DashboardState, dataset: string) {
  const shares = state.shares.filter(s => s.dataset && (s.dataset === dataset || s.dataset.startsWith(`${dataset}/`)));
  // A mount of a whole pool (homepage mounts /bulk read-only) isn't counted against each dataset.
  const mounts = state.mounts.filter(m => m.kind === 'bind' && m.vmid !== SELF_VMID && m.dataset && m.dataset.includes('/')
    && (m.dataset === dataset || m.dataset.startsWith(`${dataset}/`) || dataset.startsWith(`${m.dataset}/`)));
  return { shares, mounts };
}

function DatasetDetail({ state, names }: { state: DashboardState; names: string[] }) {
  const sets = names.map(n => state.datasets.find(d => d.name === n)).filter(Boolean) as Dataset[];
  if (sets.length === 0) return null;
  if (sets.length > 1) {
    return (
      <div className="detail-list">
        {sets.sort((a, b) => b.used - a.used).map(d => (
          <div key={d.name} className="detail-line"><code>{d.name}</code><span>{fmtBytes(d.used)}</span>
            <span className="muted">{guestOf(state, d.name)}</span></div>
        ))}
      </div>
    );
  }
  const d = sets[0];
  const { shares, mounts } = usersOf(state, d.name);
  const snaps = state.snapshots.filter(s => s.dataset === d.name);
  const newest = snaps[0];
  return (
    <div className="detail-grid">
      <div>
        <div className="detail-label">Space</div>
        <SpaceBar d={d} />
        <div className="detail-facts">
          <span>{fmtBytes(d.usedByDataset)} data</span>
          <span>{fmtBytes(d.usedBySnapshots)} in snapshots</span>
          {d.usedByChildren > 0 && <span>{fmtBytes(d.usedByChildren)} in child datasets</span>}
          {d.quota && <span>quota {fmtBytes(d.quota)}</span>}
          {d.compressratio && <span>{d.compressratio.toFixed(2)}× compression</span>}
        </div>
      </div>
      <div>
        <div className="detail-label">Used by</div>
        {shares.map(s => <div key={s.name} className="detail-line"><a href={`#/shares?share=${encodeURIComponent(s.name)}`}>⧉ {s.name}</a><span className="muted">SMB · {s.readOnly ? 'read-only' : 'read-write'}</span></div>)}
        {mounts.map(m => <div key={`${m.vmid}-${m.slot}`} className="detail-line"><span>▣ {state.guests.find(g => g.vmid === m.vmid)?.name ?? m.vmid}</span><span className="muted">{m.target}{m.readOnly ? ' · read-only' : ''}</span></div>)}
        {shares.length + mounts.length === 0 && <span className="muted">Nothing shares or mounts this dataset.</span>}
      </div>
      <div>
        <div className="detail-label">Snapshots</div>
        <div className="detail-facts">
          <span>{snaps.length} snapshot{snaps.length === 1 ? '' : 's'}</span>
          {newest ? <span>newest {timeAgo(newest.createdAt)}</span> : <StatusBadge level="critical">none</StatusBadge>}
        </div>
        <button onClick={() => navigate('snapshots', { dataset: d.name })}>Open in Snapshots</button>
      </div>
    </div>
  );
}

function guestOf(state: DashboardState, dataset: string): string {
  const m = dataset.match(/(?:subvol|vm|base)-(\d+)-disk/);
  if (!m) return '';
  const g = state.guests.find(x => x.vmid === Number(m[1]));
  return g ? `${g.name} (${g.vmid})` : `guest ${m[1]} (deleted?)`;
}

// Data and snapshot space as one bar, against `scale` (the largest dataset shown) so bars compare.
function SpaceBar({ d, scale }: { d: Dataset; scale?: number }) {
  const total = Math.max(scale ?? d.used, d.quota ?? 0, 1);
  const color = poolColor(poolOf(d.name));
  const seg = (v: number) => `${(v / total) * 100}%`;
  return (
    <span className="space-bar" title={`${fmtBytes(d.usedByDataset)} data · ${fmtBytes(d.usedBySnapshots)} snapshots · ${fmtBytes(d.usedByChildren)} children`}>
      <span style={{ width: seg(d.usedByDataset + d.usedByChildren), background: color }} />
      {d.usedBySnapshots > 0 && <span className="snap-seg" style={{ width: seg(d.usedBySnapshots), color }} />}
      {d.quota && <span className="meter-marker" style={{ left: `${(d.quota / total) * 100}%` }} />}
    </span>
  );
}

function describe(state: DashboardState, model: StorageModel) {
  return (target: MapTarget, layout: MapLayout): React.ReactNode => {
    if (target.kind === 'pool') {
      const p = state.pools.find(x => x.name === target.pool)!;
      return <><div className="tt-title">{p.name}</div><div className="tt-row"><span>Used</span><span>{fmtBytes(p.alloc)} of {fmtBytes(p.size)}</span></div><div className="tt-row"><span>Health</span><span>{p.health}</span></div></>;
    }
    if (target.kind === 'node') {
      const node = layout.nodes.find(n => n.node.id === target.id)!.node;
      const out = model.links.filter(l => l.from === node.id).length;
      return <><div className="tt-title">{node.kind === 'root' ? `${node.pool} (whole pool)` : node.members.length > 1 ? node.label : node.members[0]}</div>
        {node.kind !== 'root' && <div className="tt-row"><span>Used</span><span>{fmtBytes(node.bytes)}</span></div>}
        {node.members.length > 1 && <div className="tt-row"><span>Datasets</span><span>{node.members.length}</span></div>}
        <div className="tt-row"><span>Used by</span><span>{out || 'nothing'}</span></div></>;
    }
    if (target.kind === 'consumer') {
      const c = model.consumers.find(x => x.id === target.id)!;
      if (c.share) return <><div className="tt-title">⧉ {c.share.name}</div><div className="tt-row"><span>Path</span><span>{c.share.path}</span></div><div className="tt-row"><span>Access</span><span>{c.share.readOnly ? 'read-only' : 'read-write'}{c.share.guestOk ? ', guests allowed' : ''}</span></div><div className="tt-row"><span>Connected</span><span>{c.connections}</span></div></>;
      const g = c.guest;
      return <><div className="tt-title">▣ {c.label}</div><div className="tt-row"><span>Guest</span><span>{c.detail}</span></div>{g && <div className="tt-row"><span>Network</span><span>↓ {fmtRate(g.netinRate)} ↑ {fmtRate(g.netoutRate)}</span></div>}</>;
    }
    const l = layout.links[target.index].link;
    return <><div className="tt-title">{l.readOnly ? 'Read-only mount' : 'Read-write mount'}</div><div className="tt-row"><span>Path</span><span>{l.path}</span></div></>;
  };
}

export function StorageView({ state }: { state: DashboardState }) {
  const model = useMemo(() => buildStorageModel(state), [state]);
  const [selected, setSelected] = useState<MapTarget | null>(null);
  const datasets = state.datasets
    .filter(d => d.type === 'filesystem' && d.name.includes('/') && !isGuestDisk(d.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const maxUsed = Math.max(1, ...datasets.map(d => Math.max(d.used, d.quota ?? 0)));

  const selectedNames = (() => {
    if (!selected) return null;
    if (selected.kind === 'node') return model.groups.flatMap(g => g.nodes).find(n => n.id === selected.id)?.members ?? null;
    if (selected.kind === 'consumer') return model.links.filter(l => l.to === selected.id).flatMap(l => model.groups.flatMap(g => g.nodes).find(n => n.id === l.from)?.members.slice(0, 1) ?? []);
    return null;
  })();

  return (
    <div className="view">
      <div className="tile-row">
        {state.pools.map(p => <PoolTile key={p.name} pool={p} />)}
      </div>

      <Panel title="Where the space goes, and who uses it" aside={<Freshness collector={state.collectors.zfs} />} className="map-panel">
        <p className="panel-lede">
          Each pool fills to its used level; ribbons carry each dataset’s share of it (every pool is drawn to its own scale).
          On the right is everything that reaches into a dataset: SMB shares served by onas, and other guests’ bind mounts. Dotted links are read-only.
          Pulses show live traffic. Hover to trace a path, click to pin it.
        </p>
        <StorageMap model={model} selected={selected} onSelect={setSelected} describe={describe(state, model)} />
        {selectedNames && selectedNames.length > 0 && (
          <div className="map-detail">
            <div className="map-detail-head">
              <strong>{selectedNames.length === 1 ? selectedNames[0] : `${selectedNames.length} datasets`}</strong>
              <button className="ghost" onClick={() => setSelected(null)}>Clear</button>
            </div>
            <DatasetDetail state={state} names={selectedNames} />
          </div>
        )}
      </Panel>

      <div className="two-col">
        <Panel title="Disks" aside={<Freshness collector={state.collectors.disks} />}>
          {state.pools.map(p => <PoolLayout key={p.name} pool={p} disks={state.disks} hardware={state.hardware} />)}
        </Panel>
        <Panel title="Datasets" aside={<span className="muted">{datasets.length} filesystems</span>}>
          <table className="table">
            <thead><tr><th>Dataset</th><th className="num">Used</th><th>Data · snapshots</th><th className="num">Compression</th><th>Used by</th></tr></thead>
            <tbody>
              {datasets.map(d => {
                const { shares, mounts } = usersOf(state, d.name);
                return (
                  <tr key={d.name}>
                    <td><span className="ds-name" style={{ paddingLeft: (d.name.split('/').length - 2) * 14 }}><i className="swatch" style={{ background: poolColor(poolOf(d.name)) }} />{d.name}</span></td>
                    <td className="num">{fmtBytes(d.used)}{d.quota ? <span className="muted"> / {fmtBytes(d.quota)}</span> : null}</td>
                    <td><SpaceBar d={d} scale={maxUsed} /></td>
                    <td className="num">{d.compressratio ? `${d.compressratio.toFixed(2)}×` : '—'}</td>
                    <td className="chips">
                      {shares.map(s => <a key={s.name} className="chip" href={`#/shares?share=${encodeURIComponent(s.name)}`}>⧉ {s.name}</a>)}
                      {mounts.map(m => <span key={`${m.vmid}${m.slot}`} className="chip">▣ {state.guests.find(g => g.vmid === m.vmid)?.name ?? m.vmid}</span>)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
