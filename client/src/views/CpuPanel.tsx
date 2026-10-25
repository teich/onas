// Where the host's CPU goes: guests, host services and the kernel, in host cores, so a busy host
// can be traced to its cause. Proxmox's own numbers can't do this: guest CPU there is a share of
// the guest's vCPUs, and host processes and kernel threads (arc_prune) belong to no guest.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CpuConsumer, CpuHistory, DashboardState } from '../lib/types';
import { fetchCpuHistory } from '../lib/api';
import { Freshness, Meter, Panel, StatusBadge } from '../components/ui';
import { fmtBytes, fmtPct } from '../lib/format';
import { SERIES } from '../lib/palette';

// The three stacked groups, bottom to top, in the validated categorical order.
const GROUPS = [
  { id: 'guest', label: 'Guests', color: SERIES[0] },
  { id: 'service', label: 'Host services', color: SERIES[2] },
  { id: 'kernel', label: 'Kernel', color: SERIES[1] },
] as const;
type GroupId = (typeof GROUPS)[number]['id'];

const groupOf = (key: string): GroupId => (key.startsWith('guest-') ? 'guest' : key === 'kernel' ? 'kernel' : 'service');

// What the usual suspects are, for the reader who doesn't know kernel thread names.
const EXPLAIN: Record<string, string> = {
  arc_prune: 'ZFS evicting cached file metadata (dnodes). Sustained, it means the ARC dnode limit is too small for the files being walked.',
  arc_evict: 'ZFS shrinking its cache to its target.',
  dbuf_evict: 'ZFS evicting data buffers.',
  z_rd_int: 'ZFS finishing disk reads (checksums, decompression).',
  z_rd_iss: 'ZFS issuing disk reads.',
  z_wr_iss: 'ZFS issuing disk writes (compression, checksums).',
  z_wr_int: 'ZFS finishing disk writes.',
  txg_sync: 'ZFS committing a transaction group to disk.',
  kworker: 'General kernel work queues.',
  ksoftirqd: 'Network and disk interrupt work deferred to a thread.',
  kswapd0: 'Reclaiming memory, swapping.',
  kernel: 'Kernel threads and interrupts, outside every guest and service.',
  'wtr-offsite-backup': 'Nightly backup of photos, videos and app data to B2 (ops/host).',
  pvestatd: 'Proxmox collecting guest and storage status.',
  pvedaemon: 'The Proxmox API.',
  pveproxy: 'The Proxmox web UI and API proxy.',
  ksmtuned: 'Tunes kernel same-page merging (memory dedup for VMs).',
  'wtr-lcd': 'Draws the front LCD.',
};

const RANGES = [1, 6, 24, 168];
const fmtCores = (c: number) => (c >= 10 ? c.toFixed(0) : c >= 1 ? c.toFixed(1) : c.toFixed(2));

function useCpuHistory(hours: number) {
  const [history, setHistory] = useState<CpuHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => fetchCpuHistory(hours)
      .then(h => { if (!cancelled) { setHistory(h); setError(null); } })
      .catch(e => { if (!cancelled) setError((e as Error).message); });
    load();
    const id = setInterval(load, hours <= 1 ? 10_000 : 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [hours]);
  return { history, error };
}

interface Stacked {
  ts: number[];
  groups: Record<GroupId, number[]>;
  top: Array<Array<{ key: string; cores: number }>>; // per step, the largest consumers
  max: number;
}

function stack(h: CpuHistory): Stacked {
  const n = h.series[0]?.values.length ?? 0;
  const ts = Array.from({ length: n }, (_, i) => h.start + i * h.step);
  const groups = { guest: new Array(n).fill(0), service: new Array(n).fill(0), kernel: new Array(n).fill(0) } as Record<GroupId, number[]>;
  const has = new Array(n).fill(false);
  const top: Stacked['top'] = Array.from({ length: n }, () => []);
  for (const s of h.series) {
    if (s.key === 'busy') continue;
    const g = groupOf(s.key);
    s.values.forEach((v, i) => {
      if (v == null) return;
      has[i] = true;
      groups[g][i] += v;
      if (v >= 0.01) top[i].push({ key: s.key, cores: v });
    });
  }
  for (const t of top) t.sort((a, b) => b.cores - a.cores).splice(4);
  // A step with no sample at all (onas was down) is a gap, not zero.
  for (const g of GROUPS) groups[g.id] = groups[g.id].map((v, i) => (has[i] ? v : NaN));
  const totals = ts.map((_, i) => GROUPS.reduce((a, g) => a + (groups[g.id][i] || 0), 0));
  return { ts, groups, top, max: Math.max(0.5, ...totals) };
}

function niceTicks(max: number): number[] {
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw;
  const ticks = [];
  for (let v = step; v <= max * 1.001; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

const timeLabel = (ts: number, hours: number) => new Date(ts * 1000).toLocaleString(undefined,
  hours > 24 ? { weekday: 'short', hour: 'numeric' } : { hour: 'numeric', minute: '2-digit' });

function CpuChart({ history, names, hours }: { history: CpuHistory; names: Map<string, string>; hours: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const data = useMemo(() => stack(history), [history]);
  const n = data.ts.length;
  if (n < 2 || data.ts.every((_, i) => Number.isNaN(data.groups.kernel[i]))) {
    return <div ref={ref} className="empty">No CPU history yet. It starts with the first two samples, 10 seconds apart.</div>;
  }
  const H = 150, padL = 34, padB = 18, plotW = Math.max(100, width - padL), plotH = H - padB;
  const ticks = niceTicks(data.max);
  const top = Math.max(data.max * 1.05, ticks[ticks.length - 1] ?? 1);
  const x = (i: number) => padL + (i / (n - 1)) * plotW;
  const y = (v: number) => plotH - (v / top) * plotH;

  // Bands: cumulative from the bottom; a gap (NaN) breaks the path.
  const base = new Array(n).fill(0);
  const bands = GROUPS.map(g => {
    const lower = [...base];
    const upper = data.groups[g.id].map((v, i) => (Number.isNaN(v) ? NaN : (base[i] += v)));
    let d = '';
    let run: number[] = [];
    const flush = () => {
      if (run.length > 1) {
        d += run.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)} ${y(upper[i]).toFixed(1)}`).join('');
        d += [...run].reverse().map(i => `L${x(i).toFixed(1)} ${y(lower[i]).toFixed(1)}`).join('') + 'Z';
      }
      run = [];
    };
    for (let i = 0; i < n; i++) { if (Number.isNaN(upper[i])) flush(); else run.push(i); }
    flush();
    const edge = upper.map((v, i) => (Number.isNaN(v) ? '' : `${i && !Number.isNaN(upper[i - 1]) ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)).join('');
    return { ...g, d, edge };
  });

  const labelEvery = Math.ceil(n / Math.max(2, Math.floor(plotW / 90)));
  const onMove = (e: React.MouseEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left - padL) / plotW) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };
  const hv = hover != null && !Number.isNaN(data.groups.kernel[hover]) ? hover : null;

  return (
    <div ref={ref} className="cpu-chart" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={H} role="img" aria-label={`Host CPU by consumer over the last ${hours} hours, peak ${fmtCores(data.max)} cores`}>
        {ticks.map((t, i) => (
          <g key={t}>
            <line x1={padL} x2={width} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" className="axis-label">{fmtCores(t)}</text>
            {i === ticks.length - 1 && <text x={padL + 4} y={y(t) - 4} className="axis-label">cores</text>}
          </g>
        ))}
        <line x1={padL} x2={width} y1={plotH + 0.5} y2={plotH + 0.5} stroke="var(--axis)" />
        {bands.map(b => <path key={b.id} d={b.d} fill={b.color} opacity="0.85" />)}
        {bands.map(b => <path key={b.id} d={b.edge} fill="none" stroke="var(--surface)" strokeWidth="2" strokeLinejoin="round" />)}
        {data.ts.map((ts, i) => (i % labelEvery === 0 && i < n - labelEvery / 2
          ? <text key={ts} x={x(i)} y={H - 4} textAnchor="middle" className="axis-label">{timeLabel(ts, hours)}</text> : null))}
        {hv != null && <line x1={x(hv)} x2={x(hv)} y1={0} y2={plotH} stroke="var(--ink-2)" strokeWidth="1" />}
      </svg>
      {hv != null && (
        <div className="viz-tooltip" style={{ left: Math.min(x(hv) + 12, width - 240), top: 8 }}>
          <div className="tt-title">{new Date(data.ts[hv] * 1000).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</div>
          {[...GROUPS].reverse().map(g => (
            <div key={g.id} className="tt-row"><span><i className="swatch" style={{ background: g.color }} />{g.label}</span><span>{fmtCores(data.groups[g.id][hv])} cores</span></div>
          ))}
          {data.top[hv].length > 0 && <div className="tt-sub">Largest</div>}
          {data.top[hv].map(t => <div key={t.key} className="tt-row"><span>{names.get(t.key) ?? t.key}</span><span>{fmtCores(t.cores)}</span></div>)}
        </div>
      )}
    </div>
  );
}

function ConsumerRow({ c, total, guestCpus, sub }: { c: CpuConsumer; total: number; guestCpus?: number; sub?: boolean }) {
  const g = c.kind === 'kthread' ? null : GROUPS.find(x => x.id === (c.kind === 'guest' ? 'guest' : c.kind === 'kernel' ? 'kernel' : 'service'))!;
  const explain = EXPLAIN[c.kind === 'guest' ? '' : c.name];
  return (
    <tr className={sub ? 'cpu-sub' : ''}>
      <td>
        <span className="cpu-name">
          {g && <i className="swatch" style={{ background: g.color }} />}
          {c.kind === 'guest' ? <a href="#/guests">{c.name}</a> : c.name}
          {c.kind === 'guest' && <span className="type-tag">{c.ref}</span>}
        </span>
        {explain && <div className="muted cpu-explain">{explain}</div>}
      </td>
      <td className="num metric"><Meter value={c.cores} max={total} color={g?.color ?? SERIES[1]} />{fmtCores(c.cores)}<span className="muted"> cores</span></td>
      <td className="num">{fmtPct(c.cores / total, 1)}{guestCpus ? <div className="muted">{fmtPct(c.cores / guestCpus, 0)} of its {guestCpus} vCPU</div> : null}</td>
    </tr>
  );
}

export function CpuPanel({ state }: { state: DashboardState }) {
  const [hours, setHours] = useState(1);
  const [showAll, setShowAll] = useState(false);
  const { history, error } = useCpuHistory(hours);
  const cpu = state.cpu;
  const names = useMemo(() => new Map((cpu?.consumers ?? []).map(c => [c.key, c.name])), [cpu]);
  const vcpus = useMemo(() => new Map(state.guests.map(g => [String(g.vmid), g.maxcpu ?? 0])), [state.guests]);

  const aside = <>
    <div className="segmented" role="group" aria-label="Range">
      {RANGES.map(h => <button key={h} className={hours === h ? 'on' : ''} onClick={() => setHours(h)}>{h >= 24 ? `${h / 24}d` : `${h}h`}</button>)}
    </div>
    <Freshness collector={state.collectors.cpu} />
  </>;
  if (!cpu) return <Panel title="CPU" aside={aside}><div className="empty">Waiting for the first two CPU samples.</div></Panel>;

  const total = cpu.cores;
  const shown = showAll ? cpu.consumers : cpu.consumers.filter(c => c.cores >= 0.01);
  const hidden = cpu.consumers.length - shown.length;
  const groupNow = (id: GroupId) => cpu.consumers.filter(c => (c.kind === 'guest' ? 'guest' : c.kind === 'kernel' ? 'kernel' : 'service') === id).reduce((a, c) => a + c.cores, 0);
  const arc = cpu.arc;
  const dnodeFrac = arc && arc.dnodeLimitBytes ? arc.dnodeBytes / arc.dnodeLimitBytes : 0;

  return (
    <Panel title="CPU" aside={aside}>
      <div className="cpu-head">
        <span className="hero-number">{fmtCores(cpu.busyCores)}<span>of {total} cores busy · {fmtPct(cpu.busyCores / total, 1)}</span></span>
        <span className="legend">
          {GROUPS.map(g => <span key={g.id}><i className="swatch" style={{ background: g.color }} />{g.label} <b className="cpu-legend-val">{fmtCores(groupNow(g.id))}</b></span>)}
          <span className="muted" title="Idle time spent waiting for disk. Not counted as busy.">waiting on disk {fmtCores(cpu.iowaitCores)}</span>
        </span>
      </div>
      {error && <div className="form-error">{error}</div>}
      {history && <CpuChart history={history} names={names} hours={hours} />}

      {arc && (
        <div className="cpu-arc">
          <span className="muted">ZFS ARC</span>
          <span>{fmtBytes(arc.sizeBytes)} <span className="muted">of {fmtBytes(arc.maxBytes)}</span></span>
          <span className="muted">dnodes</span>
          <span className="cpu-arc-meter"><Meter value={arc.dnodeBytes} max={Math.max(arc.dnodeBytes, arc.dnodeLimitBytes)} marker={arc.dnodeLimitBytes} color={dnodeFrac >= 1 ? 'var(--warning)' : SERIES[0]} label="dnode cache against its limit" />
            {fmtBytes(arc.dnodeBytes)} <span className="muted">of {fmtBytes(arc.dnodeLimitBytes)} limit</span></span>
          {dnodeFrac >= 1
            ? <StatusBadge level="warning">over the limit: arc_prune {arc.pruneRate != null ? `${Math.round(arc.pruneRate)}/s` : 'running'}</StatusBadge>
            : <span className="muted">arc_prune {arc.pruneRate != null ? `${Math.round(arc.pruneRate)}/s` : '—'}</span>}
        </div>
      )}

      <table className="table cpu-table">
        <thead><tr><th>Using CPU now</th><th className="num">Cores</th><th className="num">Of host</th></tr></thead>
        <tbody>
          {shown.map(c => (
            <ConsumerFragment key={c.key} c={c} total={total} vcpus={c.kind === 'guest' ? vcpus.get(c.ref ?? '') : undefined} threads={c.kind === 'kernel' ? cpu.kernelThreads.filter(t => t.cores >= 0.005) : []} />
          ))}
        </tbody>
      </table>
      {hidden > 0 && <button className="ghost" onClick={() => setShowAll(true)}>{hidden} more under 0.01 cores</button>}
      {showAll && <button className="ghost" onClick={() => setShowAll(false)}>Show fewer</button>}
    </Panel>
  );
}

function ConsumerFragment({ c, total, vcpus, threads }: { c: CpuConsumer; total: number; vcpus?: number; threads: CpuConsumer[] }) {
  return (
    <>
      <ConsumerRow c={c} total={total} guestCpus={vcpus} />
      {threads.map(t => <ConsumerRow key={t.key} c={t} total={total} sub />)}
    </>
  );
}
