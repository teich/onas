// Activity heatmap: every guest (and the host) as a row, time as columns of 5-minute (or
// 30-minute) buckets, one metric at a time. A fragment shader samples the matrix from an
// r32float texture and maps it onto one blue ramp (interpolated in OKLab), with 1px surface
// gaps between rows and a hatch where there's no data.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryMatrix } from '../lib/types';
import { alphaBlend, hex, shaderModule, useGpuCanvas, WGSL_COMMON, type Gpu, type Renderer } from '../lib/gpu';
import { SEQUENTIAL } from '../lib/palette';
import { fmtDateTime, fmtPct, fmtRate } from '../lib/format';

export interface HeatRow { id: string; label: string; sublabel?: string }

export const METRICS: Array<{ key: string; label: string; scale: 'fraction' | 'sqrt' | 'rate' | 'pressure'; help: string }> = [
  { key: 'cpu', label: 'CPU', scale: 'sqrt', help: 'Share of the CPUs each guest is allowed to use (square-root scale, so light use still shows)' },
  { key: 'mem', label: 'Memory', scale: 'fraction', help: 'Share of each guest\'s memory in use' },
  { key: 'netin', label: 'Net in', scale: 'rate', help: 'Bytes per second received (log scale)' },
  { key: 'netout', label: 'Net out', scale: 'rate', help: 'Bytes per second sent (log scale)' },
  { key: 'psi_io', label: 'I/O stall', scale: 'pressure', help: 'Share of time tasks waited on I/O (PSI "some", square-root scale)' },
  { key: 'psi_cpu', label: 'CPU stall', scale: 'pressure', help: 'Share of time tasks waited for a CPU (PSI "some", square-root scale)' },
];

const ROW_H = 22;
const AXIS_H = 26;

// Values → 0..1 on the colour scale. Rates use log10 from 1 KB/s to 100 MB/s.
export function normalise(value: number, scale: string): number {
  if (scale === 'rate') return value < 1024 ? 0 : Math.min(1, Math.log10(value / 1024) / 5);
  if (scale === 'pressure') return Math.min(1, Math.sqrt(Math.max(0, value) / 100));
  if (scale === 'sqrt') return Math.min(1, Math.sqrt(Math.max(0, value)));
  return Math.min(1, Math.max(0, value));
}

export function formatValue(value: number | null, scale: string): string {
  if (value == null) return 'no data';
  if (scale === 'rate') return fmtRate(value);
  if (scale === 'pressure') return `${value.toFixed(1)}%`;
  return fmtPct(value, 1);
}

const SHADER = /* wgsl */ `
${WGSL_COMMON}
struct U { size: vec2f, grid: vec2f, hover: vec2f, rowh: f32, top: f32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var data: texture_2d<f32>;
@group(0) @binding(2) var<uniform> ramp: array<vec4f, 12>;

struct Out { @builtin(position) pos: vec4f, @location(0) p: vec2f };

@vertex fn vs(@builtin(vertex_index) vi: u32) -> Out {
  let c = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u));
  var o: Out;
  o.pos = vec4f(c.x * 2.0 - 1.0, 1.0 - c.y * 2.0, 0.0, 1.0);
  o.p = c * u.size;
  return o;
}

fn ramp_at(v: f32) -> vec3f {
  let x = clamp(v, 0.0, 1.0) * 11.0;
  let i = u32(floor(x));
  let j = min(i + 1u, 11u);
  return mix_oklab(ramp[i].rgb, ramp[j].rgb, fract(x));
}

@fragment fn fs(i: Out) -> @location(0) vec4f {
  let y = i.p.y - u.top;
  if (y < 0.0) { discard; }
  let row = floor(y / u.rowh);
  if (row >= u.grid.y) { discard; }
  let col = floor(i.p.x / u.size.x * u.grid.x);
  let in_row = y - row * u.rowh;
  // 1px surface gap between rows.
  if (in_row < 1.0) { discard; }
  let v = textureLoad(data, vec2u(u32(col), u32(row)), 0).r;
  var c: vec3f;
  var a = 1.0;
  if (v < 0.0) {
    // No data: faint 45° hatch.
    let h = fract((i.p.x + i.p.y) / 6.0);
    c = vec3f(1.0);
    a = select(0.025, 0.07, h < 0.3);
  } else {
    c = ramp_at(v);
  }
  // Crosshair on the hovered row and column.
  let on_row = row == u.hover.y;
  let on_col = col == u.hover.x;
  if (u.hover.x >= 0.0 && (on_row || on_col)) {
    c = mix(c, vec3f(1.0), select(0.10, 0.22, on_row && on_col));
    a = max(a, 0.12);
  }
  return vec4f(c * a, a);
}
`;

class HeatmapRenderer implements Renderer {
  private uniforms: GPUBuffer;
  private rampBuf: GPUBuffer;
  private texture: GPUTexture | null = null;
  private bind: GPUBindGroup | null = null;
  private grid = [1, 1];
  private size = [1, 1];
  hover = [-1, -1];

  constructor(private device: GPUDevice, private pipeline: GPURenderPipeline) {
    this.uniforms = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.rampBuf = device.createBuffer({ size: 12 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.rampBuf, 0, new Float32Array(SEQUENTIAL.flatMap(c => [...hex(c), 1])));
  }

  static async create({ device, format }: Gpu) {
    const module = await shaderModule(device, 'activity heatmap', SHADER);
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [alphaBlend(format)] },
      primitive: { topology: 'triangle-strip' },
    });
    return new HeatmapRenderer(device, pipeline);
  }

  setMatrix(values: Float32Array, cols: number, rows: number) {
    if (!this.texture || this.texture.width !== cols || this.texture.height !== rows) {
      this.texture?.destroy();
      this.texture = this.device.createTexture({ size: [cols, rows], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      this.bind = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniforms } },
          { binding: 1, resource: this.texture.createView() },
          { binding: 2, resource: { buffer: this.rampBuf } },
        ],
      });
    }
    this.device.queue.writeTexture({ texture: this.texture }, values.buffer as ArrayBuffer, { bytesPerRow: cols * 4 }, [cols, rows]);
    this.grid = [cols, rows];
  }

  resize(width: number, height: number) {
    this.size = [width, height];
  }

  frame(pass: GPURenderPassEncoder) {
    if (!this.bind) return false;
    this.device.queue.writeBuffer(this.uniforms, 0, new Float32Array([...this.size, ...this.grid, ...this.hover, ROW_H, AXIS_H]));
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.draw(4);
    return false;
  }

  destroy() {
    this.texture?.destroy();
    this.uniforms.destroy();
    this.rampBuf.destroy();
  }
}

export function ActivityHeatmap({ matrix, rows, metric }: { matrix: HistoryMatrix | null; rows: HeatRow[]; metric: (typeof METRICS)[number] }) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [plotW, setPlotW] = useState(800);
  const [hover, setHover] = useState<{ col: number; row: number; x: number; y: number } | null>(null);
  const { canvasRef, renderer, error, handle } = useGpuCanvas(gpu => HeatmapRenderer.create(gpu), []);
  const cols = matrix ? Math.round((matrix.end - matrix.start) / matrix.step) : 1;
  const height = AXIS_H + rows.length * ROW_H;

  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setPlotW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const byId = useMemo(() => new Map(matrix?.series.map(s => [s.id, s.values]) ?? []), [matrix]);

  useEffect(() => {
    if (!renderer || !matrix || rows.length === 0) return;
    const data = new Float32Array(cols * rows.length).fill(-1);
    rows.forEach((row, r) => {
      const values = byId.get(row.id);
      if (!values) return;
      for (let c = 0; c < cols; c++) {
        const v = values[c];
        if (v != null) data[r * cols + c] = normalise(v, metric.scale);
      }
    });
    renderer.setMatrix(data, cols, rows.length);
    handle.invalidate();
  }, [renderer, matrix, rows, byId, cols, metric, handle]);

  useEffect(() => {
    if (!renderer) return;
    renderer.hover = hover ? [hover.col, hover.row] : [-1, -1];
    handle.invalidate();
  }, [renderer, hover, handle]);

  const onMove = (e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top - AXIS_H;
    const row = Math.floor(y / ROW_H);
    const col = Math.floor((x / rect.width) * cols);
    setHover(y >= 0 && row < rows.length && col >= 0 && col < cols ? { col, row, x, y: y + AXIS_H } : null);
  };

  // Hour ticks every 3h (24h view) or daily (longer).
  const axis = useMemo(() => {
    if (!matrix) return [];
    const out: Array<{ x: number; label: string }> = [];
    const span = matrix.end - matrix.start;
    const step = span <= 2 * 86400 ? 3 * 3600 : 86400;
    const tz = -new Date().getTimezoneOffset() * 60;
    for (let t = Math.ceil((matrix.start + tz) / step) * step - tz; t < matrix.end; t += step) {
      const d = new Date(t * 1000);
      out.push({ x: ((t - matrix.start) / span) * plotW, label: step < 86400 ? d.toLocaleTimeString([], { hour: 'numeric' }) : d.toLocaleDateString([], { weekday: 'short', day: 'numeric' }) });
    }
    return out;
  }, [matrix, plotW]);

  const hovered = hover && matrix ? {
    row: rows[hover.row],
    value: byId.get(rows[hover.row]?.id)?.[hover.col] ?? null,
    at: (matrix.start + hover.col * matrix.step) * 1000,
  } : null;

  return (
    <div className="heatmap">
      <div className="heatmap-body" style={{ height }}>
        <div className="heatmap-labels">
          {rows.map((row, i) => (
            <div key={row.id} className={`heatmap-label${hover?.row === i ? ' on' : ''}`} style={{ top: AXIS_H + i * ROW_H, height: ROW_H }}>
              <span>{row.label}</span>{row.sublabel && <span className="muted">{row.sublabel}</span>}
            </div>
          ))}
        </div>
        <div className="heatmap-plot" ref={plotRef} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          <canvas ref={canvasRef} className="viz-canvas" />
          <div className="timeline-axis">{axis.map(a => <span key={a.x} style={{ left: a.x }}>{a.label}</span>)}</div>
          {hovered && hover && (
            <div className="viz-tooltip" style={{ left: Math.min(hover.x + 14, plotW - 220), top: hover.y + 10 }}>
              <div className="tt-title">{hovered.row.label}</div>
              <div className="tt-row"><span>{metric.label}</span><span className="num-strong">{formatValue(hovered.value, metric.scale)}</span></div>
              <div className="tt-row"><span>At</span><span>{fmtDateTime(hovered.at)}</span></div>
            </div>
          )}
          {error && <div className="viz-error">{error}</div>}
        </div>
      </div>
      <div className="heatmap-legend">
        <span className="muted">{metric.help}</span>
        <span className="ramp">
          <span>{metric.scale === 'rate' ? '1 KB/s' : '0%'}</span>
          <i style={{ background: `linear-gradient(90deg, ${SEQUENTIAL.join(', ')})` }} />
          {(metric.scale === 'sqrt' || metric.scale === 'pressure') && <span className="ramp-mid">25% at the middle</span>}
          <span>{metric.scale === 'rate' ? '100 MB/s' : '100%'}</span>
        </span>
        <span><i className="swatch hatch" />no data</span>
      </div>
    </div>
  );
}
