// Snapshot timeline: one row per dataset, time left → right. Each snapshot is a dot sized by
// the space only it holds (ZFS "used"), coloured by where it came from. On data datasets the
// stretch since the newest snapshot is shaded by how exposed it is: amber after a day, and
// hatched red past a week or when there is none. Drag to pan; pinch or ⌘-scroll to zoom.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot } from '../lib/types';
import { alphaBlend, hex, shaderModule, upload, useGpuCanvas, WGSL_COMMON, type Gpu, type Renderer } from '../lib/gpu';
import { SERIES, STATUS } from '../lib/palette';
import { fmtBytes, fmtDateTime, timeAgo } from '../lib/format';

export type SnapshotOrigin = 'manual' | 'proxmox' | 'automatic';
export const ORIGIN_COLOR: Record<SnapshotOrigin, string> = { manual: SERIES[0], proxmox: SERIES[1], automatic: SERIES[2] };
export const ORIGIN_LABEL: Record<SnapshotOrigin, string> = { manual: 'Manual', proxmox: 'Proxmox', automatic: 'Automatic' };

export function snapshotOrigin(s: Snapshot): SnapshotOrigin {
  if (/^(autosnap_|zfs-auto-snap|sanoid|syncoid|(hourly|daily|weekly|monthly|frequent)[-_])/.test(s.snapname)) return 'automatic';
  if (/\/(subvol|vm|base)-\d+-disk-\d+$/.test(s.dataset) && !/^(manual-|pre-)/.test(s.snapname)) return 'proxmox';
  if (/^vzdump/.test(s.snapname)) return 'proxmox';
  return 'manual';
}

export interface TimelineRow {
  dataset: string;
  label: string;
  sublabel: string;
  snapshots: Snapshot[];
  protect: boolean; // a data dataset: show how long since its last snapshot
}

const ROW_H = 34;
const AXIS_H = 28;
const DAY = 86400;
// Times go to the GPU as f32 seconds relative to this base, which keeps them precise.
const BASE = Math.floor(Date.now() / 1000) - 400 * DAY;

export function coverageLevel(row: TimelineRow, now = Date.now()): 'good' | 'warning' | 'critical' | null {
  if (!row.protect) return null;
  const newest = Math.max(0, ...row.snapshots.map(s => new Date(s.createdAt).getTime()));
  if (!newest) return 'critical';
  const age = (now - newest) / 1000;
  return age <= DAY ? 'good' : age <= 7 * DAY ? 'warning' : 'critical';
}

const SHADER = /* wgsl */ `
${WGSL_COMMON}
struct U { size: vec2f, view: vec2f, now: f32, tz: f32, time: f32, dpr: f32 };
@group(0) @binding(0) var<uniform> u: U;

fn x_of(t: f32) -> f32 { return (t - u.view.x) / (u.view.y - u.view.x) * u.size.x; }
fn t_of(x: f32) -> f32 { return u.view.x + x / u.size.x * (u.view.y - u.view.x); }
fn to_clip(p: vec2f) -> vec4f { return vec4f(p.x / u.size.x * 2.0 - 1.0, 1.0 - p.y / u.size.y * 2.0, 0.0, 1.0); }

// ---- rows: zebra, day grid, coverage band, now line ----
struct Row { @location(0) r: vec4f, @location(1) col: vec4f };
struct RowOut { @builtin(position) pos: vec4f, @location(0) p: vec2f, @location(1) r: vec4f, @location(2) col: vec4f };

@vertex fn row_vs(@builtin(vertex_index) vi: u32, row: Row) -> RowOut {
  // r = (y, height, coverage start (or -1), flags: 1 = zebra, 2 = hatched)
  let c = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u));
  let p = vec2f(c.x * u.size.x, row.r.x + c.y * row.r.y);
  var o: RowOut;
  o.pos = to_clip(p);
  o.p = p;
  o.r = row.r;
  o.col = row.col;
  return o;
}

@fragment fn row_fs(i: RowOut) -> @location(0) vec4f {
  let t = t_of(i.p.x);
  let px = (u.view.y - u.view.x) / u.size.x; // seconds per pixel
  let flags = u32(i.r.w);
  var c = vec3f(1.0);
  var a = select(0.0, 0.018, (flags & 1u) != 0u);
  // Day lines (local midnight), fading out when days get too dense to read.
  let day_px = 86400.0 / px;
  let dday = abs(fract((t + u.tz) / 86400.0 + 0.5) - 0.5) * 86400.0 / px;
  let grid = (1.0 - smoothstep(0.0, 1.0, dday)) * smoothstep(6.0, 18.0, day_px) * 0.07;
  a = max(a, grid);
  // Coverage: shaded from the newest snapshot (or the start of time) to now.
  let cov = i.r.z;
  let local_y = i.p.y - i.r.x;
  if (cov > -0.5 && t >= cov && t <= u.now && local_y > 3.0 && local_y < i.r.y - 3.0) {
    var band = 0.13;
    if ((flags & 2u) != 0u) {
      // 45° hatch: the texture channel, so exposure doesn't rest on colour alone.
      let h = fract((i.p.x + i.p.y) / 7.0);
      band = select(0.07, 0.30, h < 0.38);
    }
    let fade_in = smoothstep(cov, cov + px * 6.0, t);
    c = mix(c, i.col.rgb, 1.0);
    a = max(a, band * fade_in);
  }
  // Now: a thin bright line with a soft glow.
  let dn = abs(t - u.now) / px;
  let now_line = exp(-(dn * dn) / 1.2) * 0.85 + exp(-(dn * dn) / 40.0) * 0.18;
  if (now_line > a) { c = vec3f(0.94, 0.93, 0.92); a = now_line; }
  return vec4f(c * a, a);
}

// ---- snapshot dots ----
struct Dot { @location(0) d: vec4f, @location(1) col: vec4f };
struct DotOut { @builtin(position) pos: vec4f, @location(0) local: vec2f, @location(1) d: vec4f, @location(2) col: vec4f };

@vertex fn dot_vs(@builtin(vertex_index) vi: u32, dot: Dot) -> DotOut {
  // d = (time, y centre, radius, state: 0 normal, 1 hover, 2 selected, 3 dimmed)
  let c = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  let ext = dot.d.z + 10.0;
  let centre = vec2f(x_of(dot.d.x), dot.d.y);
  var o: DotOut;
  o.pos = to_clip(centre + c * ext);
  o.local = c * ext;
  o.d = dot.d;
  o.col = dot.col;
  return o;
}

@fragment fn dot_fs(i: DotOut) -> @location(0) vec4f {
  let r = length(i.local);
  let rad = i.d.z;
  let state = i.d.w;
  let body = 1.0 - smoothstep(rad - 0.75, rad + 0.75, r);
  // A 2px surface-coloured ring separates overlapping dots.
  let ring_cut = smoothstep(rad - 0.5, rad + 0.5, r) * (1.0 - smoothstep(rad + 1.5, rad + 2.5, r));
  let glow = exp(-(r - rad) * (r - rad) / 18.0) * select(0.18, 0.55, state > 0.5 && state < 2.5);
  let sel = select(0.0, 1.0 - smoothstep(0.6, 1.4, abs(r - (rad + 4.0))), state > 1.5 && state < 2.5);
  let dim = select(1.0, 0.28, state > 2.5);
  // Lighter at the top-left: a little volume.
  let shade = mix_oklab(min(i.col.rgb * 1.3, vec3f(1.0)), i.col.rgb, clamp(0.5 + (i.local.x + i.local.y) / (rad * 2.5), 0.0, 1.0));
  let core_a = body * 0.95;
  var c = shade * core_a + i.col.rgb * glow * (1.0 - body) + vec3f(0.95) * sel;
  var a = max(core_a, max(glow * (1.0 - ring_cut) * (1.0 - body), sel));
  return vec4f(c * dim, a * dim);
}
`;

class TimelineRenderer implements Renderer {
  private uniforms: GPUBuffer;
  private bind: GPUBindGroup;
  private rowBuf: GPUBuffer | null = null;
  private dotBuf: GPUBuffer | null = null;
  private counts = { rows: 0, dots: 0 };
  private size = [1, 1];
  private dpr = 1;
  view: [number, number] = [0, 1];

  constructor(private device: GPUDevice, private rowPipe: GPURenderPipeline, private dotPipe: GPURenderPipeline, layout: GPUBindGroupLayout) {
    this.uniforms = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bind = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.uniforms } }] });
  }

  static async create({ device, format }: Gpu) {
    const module = await shaderModule(device, 'snapshot timeline', SHADER);
    const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const inst: GPUVertexBufferLayout = {
      arrayStride: 32, stepMode: 'instance',
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }, { shaderLocation: 1, offset: 16, format: 'float32x4' }],
    };
    const make = (vs: string, fs: string) => device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: vs, buffers: [inst] },
      fragment: { module, entryPoint: fs, targets: [alphaBlend(format)] },
      primitive: { topology: 'triangle-strip' },
    });
    return new TimelineRenderer(device, make('row_vs', 'row_fs'), make('dot_vs', 'dot_fs'), layout);
  }

  setData(rows: Float32Array, dots: Float32Array) {
    this.rowBuf = upload(this.device, this.rowBuf, rows, GPUBufferUsage.VERTEX, 'timeline rows');
    this.dotBuf = upload(this.device, this.dotBuf, dots, GPUBufferUsage.VERTEX, 'timeline dots');
    this.counts = { rows: rows.length / 8, dots: dots.length / 8 };
  }

  resize(width: number, height: number, dpr: number) {
    this.size = [width, height];
    this.dpr = dpr;
  }

  frame(pass: GPURenderPassEncoder, time: number) {
    const now = Date.now() / 1000 - BASE;
    const tz = -new Date().getTimezoneOffset() * 60;
    this.device.queue.writeBuffer(this.uniforms, 0, new Float32Array([this.size[0], this.size[1], this.view[0], this.view[1], now, tz, time, this.dpr]));
    pass.setBindGroup(0, this.bind);
    if (this.counts.rows && this.rowBuf) {
      pass.setPipeline(this.rowPipe);
      pass.setVertexBuffer(0, this.rowBuf);
      pass.draw(4, this.counts.rows);
    }
    if (this.counts.dots && this.dotBuf) {
      pass.setPipeline(this.dotPipe);
      pass.setVertexBuffer(0, this.dotBuf);
      pass.draw(4, this.counts.dots);
    }
    return false;
  }

  destroy() {
    this.rowBuf?.destroy();
    this.dotBuf?.destroy();
    this.uniforms.destroy();
  }
}

const PRESETS: Array<[string, number]> = [['24h', 1], ['7d', 7], ['30d', 30], ['90d', 90], ['1y', 365]];

function ticks(start: number, end: number, width: number): Array<{ t: number; label: string }> {
  const span = end - start;
  const steps = [3600, 3 * 3600, 6 * 3600, 12 * 3600, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 91 * DAY];
  const step = steps.find(s => (s / span) * width >= 90) ?? 182 * DAY;
  const out: Array<{ t: number; label: string }> = [];
  const tz = -new Date().getTimezoneOffset() * 60;
  let t = Math.ceil((start + BASE + tz) / step) * step - tz - BASE;
  for (; t < end; t += step) {
    const d = new Date((t + BASE) * 1000);
    const label = step < DAY
      ? d.toLocaleTimeString([], { hour: 'numeric' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    out.push({ t, label });
  }
  return out;
}

export function SnapshotTimeline({ rows, selected, onSelect, renderLabel }: {
  rows: TimelineRow[];
  selected: Snapshot | null;
  onSelect: (snapshot: Snapshot | null) => void;
  renderLabel: (row: TimelineRow) => React.ReactNode;
}) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [plotW, setPlotW] = useState(800);
  const now = Date.now() / 1000 - BASE;
  const [view, setView] = useState<[number, number]>([now - 30 * DAY, now + 2 * DAY]);
  const [hover, setHover] = useState<{ snap: Snapshot; x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; view: [number, number]; moved: boolean } | null>(null);
  const { canvasRef, renderer, error, handle } = useGpuCanvas(gpu => TimelineRenderer.create(gpu), []);
  const height = AXIS_H + rows.length * ROW_H + 8;

  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setPlotW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const maxUsed = useMemo(() => Math.max(1, ...rows.flatMap(r => r.snapshots.map(s => s.usedBytes))), [rows]);
  const radius = (s: Snapshot) => 4 + Math.sqrt(s.usedBytes / maxUsed) * 8;

  // Dot positions in plot coordinates, for hit testing.
  const dots = useMemo(() => rows.flatMap((row, ri) => row.snapshots.map(s => ({
    snap: s, row: ri, t: new Date(s.createdAt).getTime() / 1000 - BASE, y: AXIS_H + ri * ROW_H + ROW_H / 2, r: radius(s),
  }))), [rows, maxUsed]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!renderer) return;
    const rowData: number[] = [];
    rows.forEach((row, i) => {
      const level = coverageLevel(row);
      const newest = Math.max(0, ...row.snapshots.map(s => new Date(s.createdAt).getTime() / 1000 - BASE));
      const covStart = level && level !== 'good' ? (newest || view[0] - 365 * DAY) : -1;
      const col = hex(level === 'critical' ? STATUS.critical : STATUS.warning);
      const flags = (i % 2 === 0 ? 1 : 0) | (level === 'critical' ? 2 : 0);
      rowData.push(AXIS_H + i * ROW_H, ROW_H, covStart, flags, ...col, 1);
    });
    const dotData: number[] = [];
    for (const d of dots) {
      const isSel = selected?.name === d.snap.name;
      const isHover = hover?.snap.name === d.snap.name;
      const state = isSel ? 2 : isHover ? 1 : selected && !isSel ? 3 : 0;
      dotData.push(d.t, d.y, d.r, state, ...hex(ORIGIN_COLOR[snapshotOrigin(d.snap)]), 1);
    }
    renderer.setData(new Float32Array(rowData), new Float32Array(dotData));
    handle.invalidate();
  }, [renderer, rows, dots, selected, hover, handle, view]);

  useEffect(() => {
    if (!renderer) return;
    renderer.view = view;
    handle.invalidate();
  }, [renderer, view, handle]);

  const xOf = (t: number) => ((t - view[0]) / (view[1] - view[0])) * plotW;
  const tOf = (x: number) => view[0] + (x / plotW) * (view[1] - view[0]);

  const zoomAt = (x: number, factor: number) => {
    setView(([a, b]) => {
      const t = a + (x / plotW) * (b - a);
      const span = Math.min(800 * DAY, Math.max(3600, (b - a) * factor));
      const na = t - (x / plotW) * span;
      return [na, na + span];
    });
  };

  // Trackpad pinch: Safari sends gesture events; other engines send ctrl+wheel.
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    let lastScale = 1;
    const onWheel = (e: WheelEvent) => {
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAt(e.clientX - rect.left, Math.exp(e.deltaY * 0.01));
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        setView(([a, b]) => { const dt = (e.deltaX / plotW) * (b - a); return [a + dt, b + dt]; });
      }
    };
    type GestureEvt = Event & { scale: number; clientX: number };
    const onGestureStart = (e: Event) => { e.preventDefault(); lastScale = 1; };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureEvt;
      const rect = el.getBoundingClientRect();
      zoomAt(g.clientX - rect.left, lastScale / g.scale);
      lastScale = g.scale;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
    };
  }, [plotW]); // eslint-disable-line react-hooks/exhaustive-deps

  const hitDot = (x: number, y: number) => {
    let best: { d: (typeof dots)[number]; dist: number } | null = null;
    for (const d of dots) {
      const dist = Math.hypot(xOf(d.t) - x, d.y - y);
      if (dist <= d.r + 5 && (!best || dist < best.dist)) best = { d, dist };
    }
    return best?.d ?? null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, view, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (drag.current && (e.buttons & 1)) {
      const dx = e.clientX - drag.current.x;
      if (Math.abs(dx) > 3) drag.current.moved = true;
      const [a, b] = drag.current.view;
      const dt = (-dx / plotW) * (b - a);
      setView([a + dt, b + dt]);
      setHover(null);
      return;
    }
    const d = hitDot(x, y);
    setHover(d ? { snap: d.snap, x, y } : null);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const moved = drag.current?.moved;
    drag.current = null;
    if (moved) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const d = hitDot(e.clientX - rect.left, e.clientY - rect.top);
    onSelect(d ? d.snap : null);
  };

  const span = view[1] - view[0];
  const preset = (days: number) => setView([now - days * DAY, now + days * DAY * 0.06]);

  return (
    <div className="timeline">
      <div className="viz-controls">
        <div className="segmented" role="group" aria-label="Time range">
          {PRESETS.map(([label, days]) => (
            <button key={label} className={Math.abs(span - days * DAY * 1.06) < DAY * 0.2 ? 'on' : ''} onClick={() => preset(days)}>{label}</button>
          ))}
        </div>
        <div className="legend">
          {(Object.keys(ORIGIN_COLOR) as SnapshotOrigin[]).map(o => (
            <span key={o}><i className="swatch dot" style={{ background: ORIGIN_COLOR[o] }} />{ORIGIN_LABEL[o]}</span>
          ))}
          <span><i className="swatch hatch" />No snapshot in 7 days</span>
          <span className="muted">Dot size: space the snapshot holds</span>
        </div>
      </div>
      <div className="timeline-body" style={{ height }}>
        <div className="timeline-labels">
          {rows.map((row, i) => (
            <div key={row.dataset} className="timeline-label" style={{ top: AXIS_H + i * ROW_H, height: ROW_H }}>{renderLabel(row)}</div>
          ))}
        </div>
        <div
          className="timeline-plot"
          ref={plotRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHover(null)}
          style={{ cursor: drag.current ? 'grabbing' : hover ? 'pointer' : 'grab' }}
        >
          <canvas ref={canvasRef} className="viz-canvas" />
          <div className="timeline-axis">
            {ticks(view[0], view[1], plotW).filter(t => Math.abs(xOf(t.t) - xOf(now)) > 44).map(t => (
              <span key={t.t} style={{ left: xOf(t.t) }}>{t.label}</span>
            ))}
            <span className="now-label" style={{ left: xOf(now) }}>now</span>
          </div>
          {hover && (
            <div className="viz-tooltip" style={{ left: Math.min(hover.x + 14, plotW - 260), top: hover.y + 12 }}>
              <div className="tt-title">@{hover.snap.snapname}</div>
              <div className="tt-row"><span>Dataset</span><span>{hover.snap.dataset}</span></div>
              <div className="tt-row"><span>Taken</span><span>{fmtDateTime(hover.snap.createdAt)} · {timeAgo(hover.snap.createdAt)}</span></div>
              <div className="tt-row"><span>Holds</span><span>{fmtBytes(hover.snap.usedBytes)}</span></div>
              <div className="tt-row"><span>Refers to</span><span>{fmtBytes(hover.snap.referBytes)}</span></div>
              <div className="tt-row"><span>Origin</span><span>{ORIGIN_LABEL[snapshotOrigin(hover.snap)]}</span></div>
            </div>
          )}
          {error && <div className="viz-error">{error}</div>}
        </div>
      </div>
      <div className="viz-foot muted">Drag to pan · pinch or ⌘-scroll to zoom · showing {tOf(0) < now ? timeAgo((tOf(0) + BASE) * 1000) : ''} to now</div>
    </div>
  );
}
