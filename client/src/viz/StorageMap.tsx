// The storage map: pools (as glass columns filled to their used level) → datasets (ribbons
// whose width is bytes, to each pool's own scale) → what uses them (SMB shares and guests'
// bind mounts). Pulses travel along a link at a rate set by live traffic: a guest's network
// rate, or a share's open Samba sessions. Rendered with WebGPU; labels are DOM on top.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Consumer, DatasetNode, MapLink, StorageModel } from '../lib/storageModel';
import { alphaBlend, hex, shaderModule, upload, useGpuCanvas, WGSL_COMMON, type Gpu, type Renderer } from '../lib/gpu';
import { fmtBytes } from '../lib/format';
import { poolColor } from '../lib/palette';

// ---------- layout (CSS pixels) ----------

interface NodeBox { node: DatasetNode; x: number; y: number; w: number; h: number; slotY: number; slotH: number; srcY0: number; srcY1: number }
interface PoolBox { name: string; x: number; y: number; w: number; h: number; fillY: number; size: number; alloc: number; scale: number }
interface ConsumerBox { consumer: Consumer; x: number; y: number }
interface LinkGeom { link: MapLink; x0: number; y0: number; x1: number; y1: number; samples: Array<[number, number]> }

export interface MapLayout {
  width: number;
  height: number;
  pools: PoolBox[];
  nodes: NodeBox[];
  consumers: ConsumerBox[];
  links: LinkGeom[];
  cols: { pool: number; dataset: number; linkStart: number; consumer: number };
  groupHeaders: Array<{ label: string; y: number }>;
}

const TOP = 34;
const BAND_GAP = 40;
const SLOT_MIN = 28;
const SLOT_GAP = 6;
const CONSUMER_STEP = 34;

function bezier(x0: number, y0: number, x1: number, y1: number, t: number): [number, number] {
  const dx = (x1 - x0) * 0.5;
  const u = 1 - t;
  const x = u * u * u * x0 + 3 * u * u * t * (x0 + dx) + 3 * u * t * t * (x1 - dx) + t * t * t * x1;
  const y = u * u * u * y0 + 3 * u * u * t * y0 + 3 * u * t * t * y1 + t * t * t * y1;
  return [x, y];
}

export function layoutMap(model: StorageModel, width: number): MapLayout {
  const narrow = width < 980;
  const cols = {
    pool: narrow ? 110 : 150,
    dataset: Math.round(width * (narrow ? 0.34 : 0.37)),
    linkStart: 0,
    consumer: width - (narrow ? 170 : 220),
  };
  cols.linkStart = cols.dataset + 16 + (narrow ? 150 : 190);

  const pools: PoolBox[] = [];
  const nodes: NodeBox[] = [];
  let y = TOP;
  for (const group of model.groups) {
    const { pool } = group;
    const n = group.nodes.length;
    // Find a band height where every slot fits: slots are max(bytes * scale, SLOT_MIN).
    let band = Math.max(150, n * SLOT_MIN + (n - 1) * SLOT_GAP);
    for (let i = 0; i < 6; i++) {
      const k = band / pool.size;
      const need = group.nodes.reduce((s, nd) => s + Math.max(nd.bytes * k, SLOT_MIN), 0) + (n - 1) * SLOT_GAP;
      if (need <= band) break;
      band = need;
    }
    const scale = band / pool.size;
    const fillY = y + band - pool.alloc * scale;
    pools.push({ name: pool.name, x: cols.pool, y, w: 18, h: band, fillY, size: pool.size, alloc: pool.alloc, scale });

    const need = group.nodes.reduce((s, nd) => s + Math.max(nd.bytes * scale, SLOT_MIN), 0) + (n - 1) * SLOT_GAP;
    let slotY = y + (band - need) / 2;
    let src = fillY;
    for (const node of group.nodes) {
      const h = node.bytes * scale;
      const slotH = Math.max(h, SLOT_MIN);
      nodes.push({
        node, x: cols.dataset, w: 8, h, y: slotY + (slotH - h) / 2, slotY, slotH,
        srcY0: src, srcY1: src + h,
      });
      src += h;
      slotY += slotH + SLOT_GAP;
    }
    y += band + BAND_GAP;
  }
  const bandsBottom = y - BAND_GAP;

  // Consumers: shares, then services, each ordered by where their sources sit, to keep links
  // from crossing more than they must.
  const nodeY = new Map(nodes.map(nb => [nb.node.id, nb.slotY + nb.slotH / 2]));
  const bary = (c: Consumer) => {
    const ys = model.links.filter(l => l.to === c.id).map(l => nodeY.get(l.from) ?? 0);
    return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;
  };
  const shares = model.consumers.filter(c => c.kind === 'share').sort((a, b) => bary(a) - bary(b));
  const services = model.consumers.filter(c => c.kind === 'service').sort((a, b) => bary(a) - bary(b));
  const blocks = [{ label: 'SMB shares', items: shares }, { label: 'Services (bind mounts)', items: services }].filter(b => b.items.length);
  const consumerHeight = blocks.reduce((s, b) => s + 22 + b.items.length * CONSUMER_STEP, 0) + (blocks.length - 1) * 18;
  const height = Math.max(bandsBottom + 20, TOP + consumerHeight + 20);
  let cy = TOP + Math.max(0, (height - TOP - 20 - consumerHeight) / 2);
  const consumers: ConsumerBox[] = [];
  const groupHeaders: MapLayout['groupHeaders'] = [];
  for (const block of blocks) {
    groupHeaders.push({ label: block.label, y: cy });
    cy += 22;
    for (const c of block.items) {
      consumers.push({ consumer: c, x: cols.consumer, y: cy + CONSUMER_STEP / 2 - 4 });
      cy += CONSUMER_STEP;
    }
    cy += 18;
  }

  const consumerY = new Map(consumers.map(c => [c.consumer.id, c.y]));
  const links: LinkGeom[] = model.links.map(link => {
    const x0 = cols.linkStart;
    const y0 = nodeY.get(link.from) ?? 0;
    const x1 = cols.consumer - 7;
    const y1 = consumerY.get(link.to) ?? 0;
    const samples: Array<[number, number]> = [];
    for (let i = 0; i <= 32; i++) samples.push(bezier(x0, y0, x1, y1, i / 32));
    return { link, x0, y0, x1, y1, samples };
  });

  return { width, height, pools, nodes, consumers, links, cols, groupHeaders };
}

// ---------- hit testing ----------

export type MapTarget =
  | { kind: 'pool'; pool: string }
  | { kind: 'node'; id: string }
  | { kind: 'consumer'; id: string }
  | { kind: 'link'; index: number };

function distToSegment(px: number, py: number, [ax, ay]: [number, number], [bx, by]: [number, number]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function hitTest(layout: MapLayout, x: number, y: number): MapTarget | null {
  for (const p of layout.pools) {
    if (x >= p.x - 8 && x <= p.x + p.w + 8 && y >= p.y && y <= p.y + p.h) return { kind: 'pool', pool: p.name };
  }
  for (const nb of layout.nodes) {
    if (x >= nb.x - 6 && x <= layout.cols.linkStart && y >= nb.slotY && y <= nb.slotY + nb.slotH) return { kind: 'node', id: nb.node.id };
  }
  // Ribbons: the band between pool and dataset columns.
  const pool = layout.pools[0];
  if (pool && x > pool.x + pool.w && x < layout.cols.dataset) {
    const t = (x - (pool.x + pool.w)) / (layout.cols.dataset - (pool.x + pool.w));
    const e = t * t * (3 - 2 * t);
    for (const nb of layout.nodes) {
      const top = nb.srcY0 + (nb.y - nb.srcY0) * e;
      const bot = nb.srcY1 + (nb.y + nb.h - nb.srcY1) * e;
      if (y >= top - 2 && y <= Math.max(bot, top + 1) + 2) return { kind: 'node', id: nb.node.id };
    }
  }
  for (const c of layout.consumers) {
    if (x >= c.x - 10 && y >= c.y - 14 && y <= c.y + 14) return { kind: 'consumer', id: c.consumer.id };
  }
  let best: { index: number; d: number } | null = null;
  layout.links.forEach((l, index) => {
    for (let i = 0; i < l.samples.length - 1; i++) {
      const d = distToSegment(x, y, l.samples[i], l.samples[i + 1]);
      if (d < 6 && (!best || d < best.d)) best = { index, d };
    }
  });
  return best ? { kind: 'link', index: (best as { index: number }).index } : null;
}

// Everything connected to a target, for emphasis.
export function related(layout: MapLayout, target: MapTarget | null): Set<string> | null {
  if (!target) return null;
  const keys = new Set<string>();
  const addLink = (i: number) => {
    const l = layout.links[i].link;
    keys.add(`link:${i}`); keys.add(`node:${l.from}`); keys.add(`consumer:${l.to}`); keys.add(`pool:${l.pool}`);
  };
  if (target.kind === 'pool') {
    keys.add(`pool:${target.pool}`);
    layout.nodes.filter(n => n.node.pool === target.pool).forEach(n => keys.add(`node:${n.node.id}`));
    layout.links.forEach((l, i) => { if (l.link.pool === target.pool) addLink(i); });
  } else if (target.kind === 'node') {
    keys.add(`node:${target.id}`);
    const nb = layout.nodes.find(n => n.node.id === target.id);
    if (nb) keys.add(`pool:${nb.node.pool}`);
    layout.links.forEach((l, i) => { if (l.link.from === target.id) addLink(i); });
  } else if (target.kind === 'consumer') {
    keys.add(`consumer:${target.id}`);
    layout.links.forEach((l, i) => { if (l.link.to === target.id) addLink(i); });
  } else {
    addLink(target.index);
  }
  return keys;
}

// ---------- WebGPU renderer ----------

const SHADER = /* wgsl */ `
${WGSL_COMMON}
struct U { size: vec2f, time: f32, dpr: f32 };
@group(0) @binding(0) var<uniform> u: U;

fn to_clip(p: vec2f) -> vec4f {
  return vec4f(p.x / u.size.x * 2.0 - 1.0, 1.0 - p.y / u.size.y * 2.0, 0.0, 1.0);
}
fn ease(t: f32) -> f32 { return t * t * (3.0 - 2.0 * t); }

// ---- ribbons: pool → dataset, width = bytes ----
struct Ribbon { @location(0) a: vec4f, @location(1) b: vec4f, @location(2) colA: vec4f, @location(3) colB: vec4f };
struct RibbonOut { @builtin(position) pos: vec4f, @location(0) t: f32, @location(1) across: f32, @location(2) thick: f32,
                   @location(3) colA: vec4f, @location(4) colB: vec3f };
const SEG: u32 = 48u;

@vertex fn ribbon_vs(@builtin(vertex_index) vi: u32, r: Ribbon) -> RibbonOut {
  // r.a = (x0, y0top, y0bot, emph), r.b = (x1, y1top, y1bot, _)
  let i = vi / 2u;
  let side = f32(vi % 2u);
  let t = f32(i) / f32(SEG);
  let e = ease(t);
  let x = mix(r.a.x, r.b.x, t);
  var top = mix(r.a.y, r.b.y, e);
  var bot = mix(r.a.z, r.b.z, e);
  let thick = bot - top;
  if (thick < 1.0) { let c = (top + bot) * 0.5; top = c - 0.5; bot = c + 0.5; }
  let y = select(top - 0.75, bot + 0.75, side > 0.5);
  var o: RibbonOut;
  o.pos = to_clip(vec2f(x, y));
  o.t = t;
  o.across = select(-0.75, (bot - top) + 0.75, side > 0.5);
  o.thick = bot - top;
  o.colA = vec4f(r.colA.rgb, r.a.w);
  o.colB = r.colB.rgb;
  return o;
}

@fragment fn ribbon_fs(i: RibbonOut) -> @location(0) vec4f {
  let edge = clamp(min(i.across + 0.5, i.thick + 0.5 - i.across), 0.0, 1.0);
  let col = mix_oklab(i.colA.rgb, i.colB, smoothstep(0.0, 1.0, i.t));
  // A slow band of light drifting from pool to dataset.
  let sheen = pow(0.5 + 0.5 * sin((i.t * 3.0 - u.time * 0.12) * 6.2831), 10.0) * 0.16;
  let a = (0.34 + sheen) * i.colA.a * edge;
  return vec4f(col * a, a);
}

// ---- links: dataset → consumer, with travelling pulses ----
struct Link { @location(0) p: vec4f, @location(1) col: vec4f, @location(2) m: vec4f };
struct LinkOut { @builtin(position) pos: vec4f, @location(0) t: f32, @location(1) d: f32, @location(2) col: vec4f, @location(3) m: vec4f };
const HALF: f32 = 6.0;

fn link_point(p: vec4f, t: f32) -> vec2f {
  let dx = (p.z - p.x) * 0.5;
  let s = 1.0 - t;
  let x = s*s*s*p.x + 3.0*s*s*t*(p.x + dx) + 3.0*s*t*t*(p.z - dx) + t*t*t*p.z;
  let y = s*s*s*p.y + 3.0*s*s*t*p.y + 3.0*s*t*t*p.w + t*t*t*p.w;
  return vec2f(x, y);
}

@vertex fn link_vs(@builtin(vertex_index) vi: u32, l: Link) -> LinkOut {
  let i = vi / 2u;
  let side = select(-1.0, 1.0, (vi % 2u) == 1u);
  let t = f32(i) / f32(SEG);
  let p0 = link_point(l.p, max(t - 0.01, 0.0));
  let p1 = link_point(l.p, min(t + 0.01, 1.0));
  let dir = normalize(p1 - p0 + vec2f(1e-5, 0.0));
  let n = vec2f(-dir.y, dir.x);
  var o: LinkOut;
  o.pos = to_clip(link_point(l.p, t) + n * HALF * side);
  o.t = t;
  o.d = side * HALF;
  o.col = l.col;
  o.m = l.m;
  return o;
}

@fragment fn link_fs(i: LinkOut) -> @location(0) vec4f {
  // m = (emph, speed, readOnly, length)
  let len = i.m.w;
  let s = i.t * len;
  let core = 1.0 - smoothstep(0.55, 1.35, abs(i.d));
  // Read-only mounts are dotted.
  let dots = select(1.0, step(0.45, fract(s / 5.0)), i.m.z > 0.5);
  var a = core * dots * 0.42 * i.m.x;
  var col = i.col.rgb;
  if (i.m.y > 0.0) {
    let spacing = 46.0;
    let phase = fract(s / spacing - u.time * (0.25 + 1.4 * i.m.y));
    let along = (phase - 0.5) * spacing;
    let pulse = exp(-(along * along) / 18.0) * exp(-(i.d * i.d) / (3.0 + 4.0 * i.m.y));
    a = max(a, pulse * (0.55 + 0.45 * i.m.y) * i.m.x);
    col = mix(col, vec3f(1.0), pulse * 0.35);
  }
  return vec4f(col * a, a);
}

// ---- nodes: pool glass with liquid, dataset bars, consumer markers ----
struct Node { @location(0) rect: vec4f, @location(1) col: vec4f, @location(2) m: vec4f };
struct NodeOut { @builtin(position) pos: vec4f, @location(0) local: vec2f, @location(1) half: vec2f, @location(2) col: vec4f, @location(3) m: vec4f, @location(4) world: vec2f };

@vertex fn node_vs(@builtin(vertex_index) vi: u32, n: Node) -> NodeOut {
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u));
  let pad = 10.0;
  let p = n.rect.xy - vec2f(pad) + corner * (n.rect.zw + vec2f(pad * 2.0));
  var o: NodeOut;
  o.pos = to_clip(p);
  o.half = n.rect.zw * 0.5;
  o.local = p - (n.rect.xy + o.half);
  o.col = n.col;
  o.m = n.m;
  o.world = p;
  return o;
}

fn sd_round_box(p: vec2f, b: vec2f, r: f32) -> f32 {
  let q = abs(p) - b + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@fragment fn node_fs(i: NodeOut) -> @location(0) vec4f {
  // m = (kind, emph, fill level y (pool) | activity (consumer), _)
  let kind = i.m.x;
  let emph = i.m.y;
  let col = i.col.rgb;
  if (kind < 0.5) {
    // Pool: a glass column; liquid up to the used level with a moving surface.
    let d = sd_round_box(i.local, i.half, 5.0);
    let inside = 1.0 - smoothstep(-0.5, 0.5, d);
    let rim = (1.0 - smoothstep(0.0, 1.2, abs(d + 0.6))) * 0.55;
    let x = i.world.x;
    let wave = 1.2 * sin(x * 0.55 + u.time * 1.3) + 0.8 * sin(x * 1.7 - u.time * 0.9 + 1.3);
    let surface = i.m.z + wave;
    let below = smoothstep(surface - 0.75, surface + 0.75, i.world.y);
    let depth = clamp((i.world.y - surface) / max(i.half.y * 2.0, 1.0), 0.0, 1.0);
    let liquid = mix_oklab(min(col * 1.35, vec3f(1.0)), col * 0.62, depth);
    let dy = i.world.y - surface;
    let meniscus = exp(-(dy * dy) / 1.6) * 0.8;
    let glass = vec3f(1.0) * 0.035;
    var c = mix(glass, liquid, below) + vec3f(meniscus) * inside;
    var a = inside * mix(0.5, 0.95, below) + rim;
    c = mix(c, col, rim);
    a = clamp(a * emph, 0.0, 1.0);
    return vec4f(c * a, a);
  }
  if (kind < 1.5) {
    // Dataset bar.
    let d = sd_round_box(i.local, max(i.half, vec2f(0.5)), 2.0);
    let a = (1.0 - smoothstep(-0.5, 0.5, d)) * 0.95 * emph;
    return vec4f(col * a, a);
  }
  // Consumer marker: a ring, filled when there's live traffic, with a soft breathing halo.
  let r = length(i.local);
  let activity = i.m.z;
  let ring = 1.0 - smoothstep(0.6, 1.4, abs(r - 4.5));
  let fill = (1.0 - smoothstep(3.0, 4.0, r)) * activity;
  let dr = r - 4.5;
  let halo = exp(-(dr * dr) / (6.0 + 10.0 * activity)) * activity * (0.35 + 0.25 * sin(u.time * (1.5 + 3.0 * activity)));
  let a = clamp((max(ring, fill) + halo) * emph, 0.0, 1.0);
  return vec4f(col * a, a);
}
`;

interface MapData {
  ribbons: Float32Array; ribbonCount: number;
  links: Float32Array; linkCount: number;
  nodes: Float32Array; nodeCount: number;
}

class StorageMapRenderer implements Renderer {
  private uniforms: GPUBuffer;
  private bind: GPUBindGroup;
  private ribbonBuf: GPUBuffer | null = null;
  private linkBuf: GPUBuffer | null = null;
  private nodeBuf: GPUBuffer | null = null;
  private counts = { ribbons: 0, links: 0, nodes: 0 };
  private size = [1, 1];
  private dpr = 1;

  constructor(
    private device: GPUDevice,
    private pipelines: { ribbon: GPURenderPipeline; link: GPURenderPipeline; node: GPURenderPipeline },
    layout: GPUBindGroupLayout,
  ) {
    this.uniforms = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bind = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.uniforms } }] });
  }

  static async create({ device, format }: Gpu) {
    const module = await shaderModule(device, 'storage map', SHADER);
    const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const inst = (locations: number[]): GPUVertexBufferLayout => ({
      arrayStride: locations.length * 16,
      stepMode: 'instance',
      attributes: locations.map((loc, i) => ({ shaderLocation: loc, offset: i * 16, format: 'float32x4' as GPUVertexFormat })),
    });
    const make = (vs: string, fs: string, buffer: GPUVertexBufferLayout) => device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: vs, buffers: [buffer] },
      fragment: { module, entryPoint: fs, targets: [alphaBlend(format)] },
      primitive: { topology: 'triangle-strip' },
    });
    return new StorageMapRenderer(device, {
      ribbon: make('ribbon_vs', 'ribbon_fs', inst([0, 1, 2, 3])),
      link: make('link_vs', 'link_fs', inst([0, 1, 2])),
      node: make('node_vs', 'node_fs', inst([0, 1, 2])),
    }, layout);
  }

  setData(data: MapData) {
    const usage = GPUBufferUsage.VERTEX;
    this.ribbonBuf = upload(this.device, this.ribbonBuf, data.ribbons, usage, 'ribbons');
    this.linkBuf = upload(this.device, this.linkBuf, data.links, usage, 'links');
    this.nodeBuf = upload(this.device, this.nodeBuf, data.nodes, usage, 'nodes');
    this.counts = { ribbons: data.ribbonCount, links: data.linkCount, nodes: data.nodeCount };
  }

  resize(width: number, height: number, dpr: number) {
    this.size = [width, height];
    this.dpr = dpr;
  }

  frame(pass: GPURenderPassEncoder, time: number) {
    this.device.queue.writeBuffer(this.uniforms, 0, new Float32Array([this.size[0], this.size[1], time, this.dpr]));
    pass.setBindGroup(0, this.bind);
    const SEG_VERTS = (48 + 1) * 2;
    if (this.counts.ribbons && this.ribbonBuf) {
      pass.setPipeline(this.pipelines.ribbon);
      pass.setVertexBuffer(0, this.ribbonBuf);
      pass.draw(SEG_VERTS, this.counts.ribbons);
    }
    if (this.counts.links && this.linkBuf) {
      pass.setPipeline(this.pipelines.link);
      pass.setVertexBuffer(0, this.linkBuf);
      pass.draw(SEG_VERTS, this.counts.links);
    }
    if (this.counts.nodes && this.nodeBuf) {
      pass.setPipeline(this.pipelines.node);
      pass.setVertexBuffer(0, this.nodeBuf);
      pass.draw(4, this.counts.nodes);
    }
    return true; // liquid surfaces and pulses are always moving
  }

  destroy() {
    this.ribbonBuf?.destroy();
    this.linkBuf?.destroy();
    this.nodeBuf?.destroy();
    this.uniforms.destroy();
  }
}

const NEUTRAL = hex('#c3c2b7');

function buildData(layout: MapLayout, emphasis: Set<string> | null): MapData {
  const emph = (key: string) => (!emphasis ? 1 : emphasis.has(key) ? 1.25 : 0.22);
  const poolCol = (name: string) => hex(poolColor(name));

  const ribbons: number[] = [];
  for (const nb of layout.nodes) {
    if (nb.node.kind === 'root') continue;
    const pool = layout.pools.find(p => p.name === nb.node.pool)!;
    const c = poolCol(nb.node.pool);
    const lighter: [number, number, number] = [Math.min(1, c[0] * 1.25), Math.min(1, c[1] * 1.25), Math.min(1, c[2] * 1.25)];
    ribbons.push(pool.x + pool.w, nb.srcY0, nb.srcY1, emph(`node:${nb.node.id}`));
    ribbons.push(nb.x, nb.y, nb.y + nb.h, 0);
    ribbons.push(...c, 1, ...lighter, 1);
  }

  const links: number[] = [];
  for (const [i, l] of layout.links.entries()) {
    const consumer = layout.consumers.find(c => c.consumer.id === l.link.to)?.consumer;
    const len = l.samples.reduce((s, p, k) => (k ? s + Math.hypot(p[0] - l.samples[k - 1][0], p[1] - l.samples[k - 1][1]) : 0), 0);
    links.push(l.x0, l.y0, l.x1, l.y1);
    links.push(...poolCol(l.link.pool), 1);
    links.push(emph(`link:${i}`), consumer?.activity ?? 0, l.link.readOnly ? 1 : 0, len);
  }

  const nodes: number[] = [];
  for (const p of layout.pools) {
    nodes.push(p.x, p.y, p.w, p.h, ...poolCol(p.name), 1, 0, emph(`pool:${p.name}`), p.fillY, 0);
  }
  for (const nb of layout.nodes) {
    if (nb.node.kind === 'root') continue;
    nodes.push(nb.x, nb.y, nb.w, Math.max(nb.h, 1), ...poolCol(nb.node.pool), 1, 1, emph(`node:${nb.node.id}`), 0, 0);
  }
  for (const c of layout.consumers) {
    nodes.push(c.x - 6, c.y - 6, 12, 12, ...NEUTRAL, 1, 2, emph(`consumer:${c.consumer.id}`), c.consumer.activity, 0);
  }

  return {
    ribbons: new Float32Array(ribbons), ribbonCount: ribbons.length / 16,
    links: new Float32Array(links), linkCount: links.length / 12,
    nodes: new Float32Array(nodes), nodeCount: nodes.length / 12,
  };
}

// ---------- component ----------

export function StorageMap({ model, selected, onSelect, describe }: {
  model: StorageModel;
  selected: MapTarget | null;
  onSelect: (target: MapTarget | null) => void;
  describe: (target: MapTarget, layout: MapLayout) => React.ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const [hover, setHover] = useState<{ target: MapTarget; x: number; y: number } | null>(null);
  const layout = useMemo(() => layoutMap(model, width), [model, width]);
  const { canvasRef, renderer, error, handle } = useGpuCanvas(gpu => StorageMapRenderer.create(gpu), []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const emphasis = useMemo(() => related(layout, hover?.target ?? selected), [layout, hover, selected]);
  useEffect(() => {
    if (!renderer) return;
    renderer.setData(buildData(layout, emphasis));
    handle.invalidate();
  }, [renderer, layout, emphasis, handle]);

  const onMove = (e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const target = hitTest(layout, x, y);
    setHover(target ? { target, x, y } : null);
  };

  const dim = (key: string) => (emphasis && !emphasis.has(key) ? ' dim' : '');
  const fmtScale = (scale: number) => `1 px ≈ ${fmtBytes(1 / scale)}`;

  return (
    <div className="storage-map" ref={wrapRef} style={{ height: layout.height }}>
      <canvas ref={canvasRef} className="viz-canvas" />
      <div
        className="viz-overlay"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onClick={() => onSelect(hover?.target ?? null)}
        style={{ cursor: hover ? 'pointer' : 'default' }}
      >
        <div className="map-col-head" style={{ left: 0 }}>Pool</div>
        <div className="map-col-head" style={{ left: layout.cols.dataset }}>Dataset · used</div>
        <div className="map-col-head" style={{ left: layout.cols.consumer - 8 }}>Used by</div>
        {layout.pools.map(p => (
          <div key={p.name} className={`map-pool-label${dim(`pool:${p.name}`)}`} style={{ top: p.y, width: layout.cols.pool - 14 }}>
            <strong>{p.name}</strong>
            <span>{fmtBytes(p.alloc)} of {fmtBytes(p.size)}</span>
            <span className="num-strong">{Math.round((p.alloc / p.size) * 100)}% used</span>
            <span className="map-scale">{fmtScale(p.scale)}</span>
          </div>
        ))}
        {layout.nodes.map(nb => (
          <div
            key={nb.node.id}
            className={`map-node-label kind-${nb.node.kind}${dim(`node:${nb.node.id}`)}`}
            style={{ top: nb.slotY + nb.slotH / 2, left: nb.x + 16, width: layout.cols.linkStart - nb.x - 22 }}
          >
            <span className="name">{nb.node.label}</span>
            <span className="bytes">{nb.node.kind === 'root' ? '' : fmtBytes(nb.node.bytes)}</span>
          </div>
        ))}
        {layout.groupHeaders.map(g => (
          <div key={g.label} className="map-group-head" style={{ top: g.y, left: layout.cols.consumer - 8 }}>{g.label}</div>
        ))}
        {layout.consumers.map(c => (
          <div
            key={c.consumer.id}
            className={`map-consumer-label${dim(`consumer:${c.consumer.id}`)}`}
            style={{ top: c.y, left: c.x + 14 }}
          >
            <span className="name">{c.consumer.kind === 'share' ? '⧉ ' : '▣ '}{c.consumer.label}</span>
            {c.consumer.detail && <span className="detail">{c.consumer.detail}</span>}
          </div>
        ))}
        {hover && (
          <div className="viz-tooltip" style={{ left: Math.min(hover.x + 14, layout.width - 280), top: hover.y + 14 }}>
            {describe(hover.target, layout)}
          </div>
        )}
      </div>
      {error && <div className="viz-error">{error}</div>}
    </div>
  );
}
