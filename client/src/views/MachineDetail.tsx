// The Machine view's detail card: everything known about one slot (a drive, a network port, the
// CPU, a DIMM) in one place, with a one-hour history of what it has been doing.
import { useEffect, useState } from 'react';
import type { DashboardState } from '../lib/types';
import { StatusBadge } from '../components/ui';
import { fmtBytes, fmtDuration, fmtRate, timeAgo } from '../lib/format';
import { heatColor, poolColor } from '../lib/palette';
import { poolOf, SELF_VMID } from '../lib/storageModel';
import { fmtDriveSize, prettyModel, slotName } from '../lib/diskHealth';
import { AWAY_FROM_CPU_CSS, HEAT_RANGE, TOWARD_CPU_CSS, selfPlacement, type Slot } from '../lib/machineLens';

// ---------- history ----------

interface Series {
  label: string;
  color: string;
  points: Array<{ ts: number; value: number }>;
}

const seriesId = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');

async function fetchSeries(name: string, hours: number, signal: AbortSignal): Promise<Array<{ ts: number; value: number }>> {
  const res = await fetch(`/api/metrics?series=${encodeURIComponent(name)}&hours=${hours}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json() as { points: Array<{ ts: number; value: number }> };
  return body.points;
}

// Fetches a handful of series when the selection changes and again every 30 s while it is open.
function useHistory(specs: Array<{ name: string; label: string; color: string }>, hours = 1): { series: Series[]; failed: boolean; loaded: boolean } {
  const [state, setState] = useState<{ series: Series[]; failed: boolean; loaded: boolean }>({ series: [], failed: false, loaded: false });
  const keyed = specs.map(s => s.name).join('|');
  useEffect(() => {
    if (specs.length === 0) { setState({ series: [], failed: false, loaded: true }); return; }
    const controller = new AbortController();
    setState({ series: [], failed: false, loaded: false });
    const load = () => Promise.all(specs.map(async s => ({ label: s.label, color: s.color, points: await fetchSeries(s.name, hours, controller.signal) })))
      .then(series => setState({ series, failed: false, loaded: true }))
      .catch(err => { if ((err as Error).name !== 'AbortError') setState(s => ({ ...s, failed: true, loaded: true })); });
    load();
    const id = setInterval(load, 30_000);
    return () => { controller.abort(); clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyed, hours]);
  return state;
}

// Tiny inline chart: area + line per series over the last hour, drawn in a stretched viewBox
// with non-scaling strokes. `zero` anchors the y-axis at 0 (rates); temperatures float.
function Spark({ series, format, zero = true, hours = 1, empty }: { series: Series[]; format: (v: number) => string; zero?: boolean; hours?: number; empty: string }) {
  const W = 320, H = 54, pad = 3;
  const all = series.flatMap(s => s.points.map(p => p.value));
  const end = Math.max(...series.flatMap(s => s.points.map(p => p.ts)), 0);
  const start = end - hours * 3600;
  if (all.length < 2) return <div className="mspark-empty muted">{empty}</div>;
  const hi = Math.max(...all), lo = Math.min(...all);
  const top = zero ? Math.max(hi, 1) * 1.08 : hi + Math.max(1, (hi - lo) * 0.15);
  const bottom = zero ? 0 : lo - Math.max(1, (hi - lo) * 0.15);
  const x = (ts: number) => ((ts - start) / (end - start || 1)) * W;
  const y = (v: number) => H - pad - ((v - bottom) / (top - bottom || 1)) * (H - 2 * pad);
  return (
    <div className="mspark">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={series.map(s => `${s.label} peaked at ${format(Math.max(...s.points.map(p => p.value)))}`).join(', ')}>
        <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} className="mspark-base" />
        {series.map(s => {
          if (s.points.length < 2) return null;
          const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)} ${y(p.value).toFixed(1)}`).join('');
          return (
            <g key={s.label}>
              <path d={`${d}L${x(s.points[s.points.length - 1].ts).toFixed(1)} ${H}L${x(s.points[0].ts).toFixed(1)} ${H}Z`} fill={s.color} opacity="0.12" />
              <path d={d} fill="none" stroke={s.color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </g>
          );
        })}
      </svg>
      <div className="mspark-legend">
        {series.map(s => <span key={s.label}><i style={{ background: s.color }} />{s.label} <b>peak {format(Math.max(...s.points.map(p => p.value)))}</b></span>)}
        <span className="muted">last hour</span>
      </div>
    </div>
  );
}

// ---------- small pieces ----------

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="kv"><dt>{label}</dt><dd>{children}</dd></div>;
}

function Live({ items }: { items: Array<{ label: string; value: string; sub?: string }> }) {
  return (
    <div className="mlive">
      {items.map(i => <div key={i.label}><span className="muted">{i.label}</span><strong>{i.value}</strong>{i.sub && <span className="muted">{i.sub}</span>}</div>)}
    </div>
  );
}

const deg = (t: number | null | undefined) => (t == null ? '—' : `${Math.round(t * 10) / 10}°C`);

function dependents(state: DashboardState, pool: string) {
  const inPool = (dataset: string | null | undefined) => !!dataset && poolOf(dataset) === pool;
  const shares = state.shares.filter(s => inPool(s.dataset));
  const vmids = [...new Set(state.mounts.filter(m => inPool(m.dataset)).map(m => m.vmid))];
  const guests = vmids.map(vmid => {
    const g = state.guests.find(x => x.vmid === vmid);
    return { vmid, name: g?.name ?? `guest ${vmid}`, running: g?.status === 'running', rootfs: state.mounts.some(m => m.vmid === vmid && m.kind !== 'bind' && inPool(m.dataset)) };
  });
  return { shares, guests };
}

const CHIP_LIMIT = 8;

function WhatLivesHere({ state, slot }: { state: DashboardState; slot: Slot }) {
  const pool = slot.member?.pool;
  if (!pool) {
    return (
      <section className="msection">
        <h4>What lives here</h4>
        <p className="muted">{slot.smart?.used && /BIOS|EFI|LVM|boot/i.test(slot.smart.used)
          ? 'The system disk: Proxmox itself boots from this drive. It is not part of a ZFS pool.'
          : 'This drive is not part of a ZFS pool.'}</p>
      </section>
    );
  }
  const datasets = state.datasets.filter(d => poolOf(d.name) === pool.name && d.name !== pool.name);
  const { shares, guests } = dependents(state, pool.name);
  const shown = (items: React.ReactNode[]) => items.slice(0, CHIP_LIMIT);
  const self = selfPlacement(state);
  return (
    <section className="msection">
      <h4>What lives here</h4>
      <p>
        <strong>{pool.name}</strong> holds {datasets.length} dataset{datasets.length === 1 ? '' : 's'}, {fmtBytes(pool.alloc)} used of {fmtBytes(pool.size)}.
        {slot.member?.vdev ? <span className="muted"> This drive is one of {slot.member.vdev.children?.length ?? '?'} in {slot.member.vdev.name.replace(/-\d+$/, '')}.</span> : null}
      </p>
      {self && self.pool === pool.name && (
        <p className="mself">onas runs here: its container (VMID {SELF_VMID}) keeps its root filesystem on <code>{self.dataset}</code>.</p>
      )}
      {shares.length > 0 && (
        <div className="mdeps"><span className="muted">Shares</span>
          <div className="chips">{shown(shares.map(s => <a key={s.name} className="chip" href={`#/shares?share=${encodeURIComponent(s.name)}`}>⧉ {s.name}</a>))}
            {shares.length > CHIP_LIMIT && <span className="chip muted-chip">+{shares.length - CHIP_LIMIT}</span>}</div></div>
      )}
      {guests.length > 0 && (
        <div className="mdeps"><span className="muted">Guests</span>
          <div className="chips">{shown(guests.map(g => <span key={g.vmid} className="chip" title={g.rootfs ? 'root filesystem on this pool' : 'mounts a dataset from this pool'}>▣ {g.name}{g.rootfs ? ' · rootfs' : ''}</span>))}
            {guests.length > CHIP_LIMIT && <span className="chip muted-chip">+{guests.length - CHIP_LIMIT}</span>}</div></div>
      )}
      <a className="mlink" href="#/storage">Open Storage →</a>
    </section>
  );
}

// ---------- the cards ----------

function DriveCard({ state, slot, now }: { state: DashboardState; slot: Slot; now: number }) {
  const d = slot.disk!;
  const sm = slot.smart;
  const m = slot.member;
  const id = seriesId(d.serial || d.name);
  const hist = useHistory([
    { name: `disk.${id}.read`, label: 'read', color: TOWARD_CPU_CSS },
    { name: `disk.${id}.write`, label: 'write', color: AWAY_FROM_CPU_CSS },
  ]);
  const years = sm?.powerOnHours != null ? sm.powerOnHours / 8766 : null;
  const tempAge = d.tempAt ? Math.max(0, now - Date.parse(d.tempAt)) : null;
  return (
    <>
      <section className="msection">
        <h4>Right now</h4>
        {slot.live
          ? <Live items={[
              { label: 'Read', value: fmtRate(d.readBps) },
              { label: 'Write', value: fmtRate(d.writeBps) },
              { label: 'IOPS', value: `${Math.round(d.readIops)} / ${Math.round(d.writeIops)}`, sub: 'r / w' },
              { label: 'Busy', value: `${Math.round(d.busyPct)}%` },
            ]} />
          : <p className="muted">No live numbers: the hardware data is stale.</p>}
        <Spark series={hist.series} format={fmtRate} empty={hist.failed ? 'History is unavailable.' : hist.loaded ? 'No history yet.' : 'Loading history…'} />
      </section>

      <dl className="mfacts">
        <Fact label="Model">{sm ? prettyModel(sm.model) : '—'}</Fact>
        <Fact label="Serial"><code>{d.serial || '—'}</code></Fact>
        <Fact label="Size">{fmtDriveSize(sm?.size)}</Fact>
        <Fact label="Pool">{m
          ? <><span className="pool-chip" style={{ '--pool': poolColor(m.pool.name) } as React.CSSProperties}><i />{m.pool.name}</span> <span className="muted">{m.vdev ? m.vdev.name : 'stripe'}</span></>
          : <span className="muted">none ({sm?.used && /BIOS|EFI|LVM|boot/i.test(sm.used) ? 'system disk' : 'not in a ZFS pool'})</span>}</Fact>
        {m && <Fact label="State">{m.leaf.state.toLowerCase()}</Fact>}
        {m && <Fact label="Errors"><span title="read / write / checksum">{m.leaf.read} / {m.leaf.write} / {m.leaf.cksum}</span> <span className="muted">R / W / CKSUM</span></Fact>}
        <Fact label="SMART">{sm ? sm.health : '—'}</Fact>
        <Fact label="Temperature">
          <span className={slot.tempStale ? 'muted' : undefined}>{deg(d.tempC ?? slot.tempC)}</span>{' '}
          <span className="muted">{slot.tempStale ? `last known: ${slot.tempNote}` : d.kind === 'nvme' ? 'live' : d.tempAt ? `read ${timeAgo(d.tempAt)}` : ''}</span>
          {d.standby && tempAge != null && <div className="muted mnote">Spun down: onas does not wake it just to read the temperature.</div>}
        </Fact>
        {years != null && <Fact label="Power-on">{years.toFixed(1)} years <span className="muted">{sm!.powerOnHours!.toLocaleString()} h</span></Fact>}
        {sm?.reallocated != null && <Fact label="Reallocated">{sm.reallocated} sectors</Fact>}
        {d.kind === 'nvme' && sm?.wearout != null && <Fact label="Life left">{sm.wearout}%</Fact>}
      </dl>

      <WhatLivesHere state={state} slot={slot} />
    </>
  );
}

function NicCard({ state, slot }: { state: DashboardState; slot: Slot }) {
  const n = slot.nic;
  const hist = useHistory(n ? [
    { name: `nic.${n.name}.rx`, label: 'rx', color: TOWARD_CPU_CSS },
    { name: `nic.${n.name}.tx`, label: 'tx', color: AWAY_FROM_CPU_CSS },
  ] : []);
  if (!n) return <p className="muted">{state.hardware ? 'The hardware collector does not report this port.' : 'Waiting for the hardware collector.'}</p>;
  return (
    <>
      <section className="msection">
        <h4>Right now</h4>
        {slot.live
          ? <Live items={[{ label: 'Receiving', value: fmtRate(slot.readBps) }, { label: 'Sending', value: fmtRate(slot.writeBps) }]} />
          : <p className="muted">No live numbers: the hardware data is stale.</p>}
        <Spark series={hist.series} format={fmtRate} empty={hist.failed ? 'History is unavailable.' : hist.loaded ? 'No history yet.' : 'Loading history…'} />
      </section>
      <dl className="mfacts">
        <Fact label="Link">{n.up ? <StatusBadge level="good">up</StatusBadge> : <span className="muted">no link</span>}</Fact>
        <Fact label="Speed">{n.up && n.speedMbps ? (n.speedMbps >= 1000 ? `${n.speedMbps / 1000} Gb/s` : `${n.speedMbps} Mb/s`) : '—'}</Fact>
        <Fact label="Type">{n.kind}</Fact>
        <Fact label="Interface"><code>{n.name}</code></Fact>
      </dl>
    </>
  );
}

// The CPU, or (onScreen) the whole host as the front LCD reports it: the same numbers plus uptime and memory.
function CpuCard({ state, slot, siblings, onScreen }: { state: DashboardState; slot: Slot; siblings: Slot[]; onScreen?: boolean }) {
  const host = state.host;
  const hist = useHistory([{ name: 'cpu.temp', label: 'temperature', color: heatColor(0.7) }]);
  return (
    <>
      <dl className="mfacts">
        <Fact label="Processor">Ryzen 7 PRO 8845HS</Fact>
        <Fact label="Tctl">{deg(slot.tempC)} <span className="muted">limit {HEAT_RANGE.cpu[1]}°C</span></Fact>
        {host && <Fact label="Host CPU">{host.cpu.pct.toFixed(0)}% <span className="muted">of {host.cpu.cores} threads</span></Fact>}
        {host && <Fact label="Load">{host.load.load1.toFixed(2)} <span className="muted">{host.load.load5.toFixed(2)} · {host.load.load15.toFixed(2)} (1 · 5 · 15 min)</span></Fact>}
        {onScreen && host && <Fact label="Uptime">{fmtDuration(host.uptimeSeconds)}</Fact>}
        {onScreen && host && <Fact label="Memory">{fmtBytes(host.mem.usedBytes)} used <span className="muted">of {fmtBytes(host.mem.totalBytes)} ({Math.round((host.mem.usedBytes / host.mem.totalBytes) * 100)}%)</span></Fact>}
        {onScreen && siblings.filter(s => s.kind === 'ram').map(s => <Fact key={s.key} label={`${s.name} temp`}>{deg(s.tempC)}</Fact>)}
      </dl>
      <section className="msection">
        <h4>Temperature, last hour</h4>
        <Spark series={hist.series} format={deg} zero={false} empty={hist.failed ? 'History is unavailable.' : hist.loaded ? 'No history yet.' : 'Loading history…'} />
      </section>
    </>
  );
}

function RamCard({ state, slot, siblings }: { state: DashboardState; slot: Slot; siblings: Slot[] }) {
  const host = state.host;
  return (
    <dl className="mfacts">
      <Fact label="Temperature">{deg(slot.tempC)}</Fact>
      {siblings.filter(s => s.key !== slot.key).map(s => <Fact key={s.key} label={`${s.name} temp`}>{deg(s.tempC)}</Fact>)}
      {host && <Fact label="Memory">{fmtBytes(host.mem.usedBytes)} used <span className="muted">of {fmtBytes(host.mem.totalBytes)} ({Math.round((host.mem.usedBytes / host.mem.totalBytes) * 100)}%)</span></Fact>}
      {host && host.swap.totalBytes > 0 && <Fact label="Swap">{fmtBytes(host.swap.usedBytes)} <span className="muted">of {fmtBytes(host.swap.totalBytes)}</span></Fact>}
    </dl>
  );
}

export function MachineDetail({ state, slot, siblings, partKey, partLabel, now, onClose }: {
  state: DashboardState;
  slot: Slot | null;
  siblings: Slot[];
  partKey: string;
  partLabel: string | null;
  now: number;
  onClose: () => void;
}) {
  const onScreen = partKey === 'lcd';
  const cpu = siblings.find(s => s.key === 'cpu') ?? null;
  const assumed = (slot?.disk?.slot != null && slot.disk.slotSource === 'assumed') || (slot?.nic?.slot != null && slot.nic.slotSource === 'assumed');
  const title = slot?.name ?? partLabel ?? (onScreen ? 'Front screen' : slotName(partKey));
  const sub = onScreen ? 'The front LCD: host status as the screen shows it' : slot?.disk ? `${slot.disk.name} · ${slot.smart ? prettyModel(slot.smart.model) : slot.disk.kind}` : slot?.nic ? slot.nic.name : null;
  return (
    <section className="mdetail" aria-label={`${title} details`}>
      <header className="mdetail-head">
        <div>
          <h3>{title}</h3>
          {sub && <div className="muted mdetail-sub">{sub}</div>}
        </div>
        <button className="ghost" onClick={onClose} aria-label="Close details (Esc)" title="Close (Esc)">✕</button>
      </header>
      {slot && slot.level !== 'good' && <div className="mdetail-status"><StatusBadge level={slot.level}>{slot.note}</StatusBadge></div>}
      {slot?.disk && assumed && (
        <p className="mnote mwarn">Slot assumed from {slot.disk.kind === 'hdd' ? 'SATA port' : 'PCI'} order: confirm in <code>/etc/onas/hardware.json</code>.</p>
      )}
      {slot?.nic && assumed && (
        <p className="mnote mwarn">Slot assumed from PCI order: confirm in <code>/etc/onas/hardware.json</code>.</p>
      )}
      {!slot && !onScreen && <p className="muted">No live sensors on this part.</p>}
      {onScreen && cpu && <CpuCard key="lcd" state={state} slot={cpu} siblings={siblings} onScreen />}
      {slot?.empty && <p className="muted">{state.hardware ? 'Nothing is installed in this slot.' : 'Waiting for the hardware collector.'}</p>}
      {slot && !slot.empty && slot.disk && <DriveCard key={slot.key} state={state} slot={slot} now={now} />}
      {slot && slot.kind === 'nic' && <NicCard key={slot.key} state={state} slot={slot} />}
      {slot && slot.kind === 'cpu' && <CpuCard key={slot.key} state={state} slot={slot} siblings={siblings} />}
      {slot && slot.kind === 'ram' && <RamCard state={state} slot={slot} siblings={siblings.filter(s => s.kind === 'ram')} />}
    </section>
  );
}
