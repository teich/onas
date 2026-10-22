// The Machine scene's renderer. Per frame:
//   1. CPU, O(parts + flows): ease each part's visuals, slide and explode toward what the view
//      asked for, advance the flows, move the camera, place the labels.
//   2. Compute: every point integrates a damped spring toward its target (rest + part offset
//      + breathing + jitter + intro path), with the pointer pushing points aside.
//   3. One render pass: instanced camera-facing discs for the body and for the flow
//      particles, added into an rgba16float target.
//   4. Bloom (dual-filter down and up chain from half resolution), then tonemap, vignette and
//      grain onto the canvas.
import { shaderModule, type Gpu, type Renderer } from '../../lib/gpu';
import { OrbitCamera, rayBox } from './camera';
import { COMPOSITE_SHADER, POST_SHADER, PREFILTER_SHADER, SCENE_SHADER, SIM_SHADER } from './shaders';
import type { Flow, MachineModel, ModelManifest, PartInfo, PartVisual, Vec3 } from './types';

const HDR: GPUTextureFormat = 'rgba16float';
const MAX_FLOWS = 16;
const LUT_N = 64;
const FLOW_PARTICLES = 20480;
const MAX_PER_FLOW = 2560;
const BLOOM_LEVELS = 5;
const INTRO_SECONDS = 2.5;

const ADD: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

export interface SceneState {
  visuals: Record<string, PartVisual>;
  defaultVisual: PartVisual;
  exploded: boolean;
  xray: number;
  selected: string | null;
  hovered: string | null;
}

export interface EngineStats {
  fps: number;
  cpuMs: number;      // time spent recording a frame on the CPU
  points: number;
  flowParticles: number;
}

// Look and feel knobs, adjustable from the lab.
export interface Tuning {
  bloom: number;
  exposure: number;
  vignette: number;
  grain: number;
  threshold: number;
  knee: number;
  upGain: number;
  pointSize: number;
  repelStrength: number;
  repelRadius: number;   // metres around the pointer ray
  flowLimit: number;   // luminance ceiling for flows where they pile up
  flowBloom: number;   // how much the flows feed the bloom
  screenBloom: number; // how much the front screen feeds the bloom (its dots stay bright either way)
}

export const DEFAULT_TUNING: Tuning = {
  bloom: 1.0,
  exposure: 1.0,
  vignette: 0.35,
  grain: 0.012,
  threshold: 0.6,
  knee: 0.4,
  upGain: 0.85,
  pointSize: 1.0,
  repelStrength: 1.3,
  repelRadius: 0.011,
  flowLimit: 3.0,
  flowBloom: 0.8,
  screenBloom: 0.3,
};

export type LabelAt = 'socket' | 'center' | 'top';

interface PartRuntime {
  info: PartInfo;
  shell: boolean;
  hasExterior: boolean;
  r: number; g: number; b: number;
  intensity: number;
  activity: number;
  pulse: number;
  highlight: number;
  slideT: number;
  explodeT: number;
  offset: Vec3;
}

interface FlowRuntime {
  id: string;
  flow: Flow;
  alive: boolean;
  rate: number;
  r: number; g: number; b: number;
  phase: number;
  length: number;
  valid: boolean;
  first: number;
  count: number;
}

// The engine most recently created and not yet destroyed. The dev lab uses it for tuning and
// timing; the app never needs it.
let activeEngine: MachineEngine | null = null;
export function currentEngine(): MachineEngine | null { return activeEngine; }

const ZERO: Vec3 = [0, 0, 0];
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export function prefersReducedMotion(): boolean {
  try {
    if (new URLSearchParams(location.search).has('reduced')) return true;   // handy for the lab
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export class MachineEngine implements Renderer {
  readonly camera: OrbitCamera;
  readonly stats: EngineStats = { fps: 0, cpuMs: 0, points: 0, flowParticles: 0 };
  tuning: Tuning = { ...DEFAULT_TUNING };
  // Called once per frame after the camera moves, so labels can be placed without a re-render.
  onFrame: ((engine: MachineEngine) => void) | null = null;

  private readonly device: GPUDevice;
  private readonly format: GPUTextureFormat;
  private readonly count: number;
  private readonly reduced: boolean;
  private readonly parts: PartRuntime[];
  private readonly byKey = new Map<string, PartRuntime>();
  private readonly anchors: Record<string, Vec3>;
  private readonly seed: Vec3;
  private readonly shellBox = new Float32Array(8);     // the closed case's bounds (min, 1, max, 0), for the far-wall test
  private readonly screenInfo: ModelManifest['screen'] | null;
  private readonly screenTex: GPUTexture;
  private screenCanvas: HTMLCanvasElement | null = null;
  private screenVersion = -1;
  private screenPending = false;
  private readonly spacing: number;      // typical distance between neighbouring exterior points (m)

  private ptsBuf: GPUBuffer;
  private stateBuf: GPUBuffer;
  private partsBuf: GPUBuffer;
  private uniformBuf: GPUBuffer;
  private flowBuf: GPUBuffer;
  private lutBuf: GPUBuffer;
  private postBuf: GPUBuffer;
  private simBind: GPUBindGroup;
  private drawBind: GPUBindGroup;
  private initPipe: GPUComputePipeline;
  private stepPipe: GPUComputePipeline;
  private pointsPipe: GPURenderPipeline;
  private flowPipe: GPURenderPipeline;
  private prefilterPipe: GPURenderPipeline;
  private downPipe: GPURenderPipeline;
  private upPipe: GPURenderPipeline;
  private compositePipe: GPURenderPipeline;
  private postBgl: GPUBindGroupLayout;
  private compositeBgl: GPUBindGroupLayout;
  private prefilterBgl: GPUBindGroupLayout;
  private sampler: GPUSampler;

  private sceneTex: GPUTexture | null = null;
  private mips: GPUTexture[] = [];
  private mipViews: GPUTextureView[] = [];
  private sceneView: GPUTextureView | null = null;
  private flowTex: GPUTexture | null = null;
  private flowView: GPUTextureView | null = null;
  private prefilterBind: GPUBindGroup | null = null;
  private downBinds: GPUBindGroup[] = [];   // [l - 1] reads mip l - 1, for l >= 1
  private upBinds: GPUBindGroup[] = [];     // [l] reads mip l+1
  private compositeBind: GPUBindGroup | null = null;

  private readonly uData = new Float32Array(88);
  private readonly pData: Float32Array<ArrayBuffer>;
  private readonly partData: Float32Array<ArrayBuffer>;
  private readonly flowData = new Float32Array(MAX_FLOWS * 12);
  private readonly lutData = new Float32Array(MAX_FLOWS * LUT_N * 4);

  private scene: SceneState;
  private flows = new Map<string, FlowRuntime>();
  private flowOrder: FlowRuntime[] = [];
  private flowLayoutDirty = true;
  private flowsDirty = true;
  private partsMoved = true;

  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private devW = 1;
  private devH = 1;
  private lastTime = -1;
  private lastRaw = 0;
  private paused = false;   // dev: advance() owns the clock
  private offset = 0;     // dev: simulated time added by advance() so the live loop carries on from there
  private introStart = -1;
  private initialised = false;
  private xrayCur = 0;
  private explodeCur = 0;
  private pointer: { x: number; y: number } | null = null;
  private pointerStrength = 0;
  private pointerSuppressed = false;
  private fpsEma = 60;

  static async create({ device, format }: Gpu, model: MachineModel): Promise<MachineEngine> {
    const [simModule, sceneModule, postModule, prefilterModule, compositeModule] = await Promise.all([
      shaderModule(device, 'machine sim', SIM_SHADER),
      shaderModule(device, 'machine scene', SCENE_SHADER),
      shaderModule(device, 'machine post', POST_SHADER),
      shaderModule(device, 'machine prefilter', PREFILTER_SHADER),
      shaderModule(device, 'machine composite', COMPOSITE_SHADER),
    ]);

    const simBgl = device.createBindGroupLayout({
      label: 'machine sim',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const drawBgl = device.createBindGroupLayout({
      label: 'machine draw',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ...[1, 2, 3, 4, 5].map(binding => ({ binding, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' as const } })),
        { binding: 6, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'float' as const } },
      ],
    });
    const postBgl = device.createBindGroupLayout({
      label: 'machine post',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const prefilterBgl = device.createBindGroupLayout({
      label: 'machine prefilter',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const compositeBgl = device.createBindGroupLayout({
      label: 'machine composite',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const simLayout = device.createPipelineLayout({ bindGroupLayouts: [simBgl] });
    const drawLayout = device.createPipelineLayout({ bindGroupLayouts: [drawBgl] });
    const postLayout = device.createPipelineLayout({ bindGroupLayouts: [postBgl] });
    const prefilterLayout = device.createPipelineLayout({ bindGroupLayouts: [prefilterBgl] });
    const compositeLayout = device.createPipelineLayout({ bindGroupLayouts: [compositeBgl] });

    const post = (entry: string, blend?: GPUBlendState) => device.createRenderPipelineAsync({
      layout: postLayout,
      vertex: { module: postModule, entryPoint: 'vs_full' },
      fragment: { module: postModule, entryPoint: entry, targets: [{ format: HDR, blend }] },
      primitive: { topology: 'triangle-list' },
    });
    const [initPipe, stepPipe, pointsPipe, flowPipe, prefilterPipe, downPipe, upPipe, compositePipe] = await Promise.all([
      device.createComputePipelineAsync({ layout: simLayout, compute: { module: simModule, entryPoint: 'sim_init' } }),
      device.createComputePipelineAsync({ layout: simLayout, compute: { module: simModule, entryPoint: 'sim_step' } }),
      device.createRenderPipelineAsync({
        layout: drawLayout,
        vertex: { module: sceneModule, entryPoint: 'vs_points' },
        fragment: { module: sceneModule, entryPoint: 'fs_points', targets: [{ format: HDR, blend: ADD }, { format: HDR, writeMask: 0 }] },
        primitive: { topology: 'triangle-strip' },
      }),
      device.createRenderPipelineAsync({
        layout: drawLayout,
        vertex: { module: sceneModule, entryPoint: 'vs_flow' },
        fragment: { module: sceneModule, entryPoint: 'fs_flow', targets: [{ format: HDR, writeMask: 0 }, { format: HDR, blend: ADD }] },
        primitive: { topology: 'triangle-strip' },
      }),
      device.createRenderPipelineAsync({
        layout: prefilterLayout,
        vertex: { module: prefilterModule, entryPoint: 'vs_full' },
        fragment: { module: prefilterModule, entryPoint: 'fs_prefilter', targets: [{ format: HDR }] },
        primitive: { topology: 'triangle-list' },
      }),
      post('fs_down'),
      post('fs_up', ADD),
      device.createRenderPipelineAsync({
        layout: compositeLayout,
        vertex: { module: compositeModule, entryPoint: 'vs_full' },
        fragment: { module: compositeModule, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      }),
    ]);

    return new MachineEngine(device, format, model, {
      simBgl, drawBgl, postBgl, compositeBgl, prefilterBgl,
      initPipe, stepPipe, pointsPipe, flowPipe, prefilterPipe, downPipe, upPipe, compositePipe,
    });
  }

  private constructor(device: GPUDevice, format: GPUTextureFormat, model: MachineModel, gpu: {
    simBgl: GPUBindGroupLayout; drawBgl: GPUBindGroupLayout; postBgl: GPUBindGroupLayout; compositeBgl: GPUBindGroupLayout; prefilterBgl: GPUBindGroupLayout;
    initPipe: GPUComputePipeline; stepPipe: GPUComputePipeline; pointsPipe: GPURenderPipeline; flowPipe: GPURenderPipeline;
    prefilterPipe: GPURenderPipeline; downPipe: GPURenderPipeline; upPipe: GPURenderPipeline; compositePipe: GPURenderPipeline;
  }) {
    this.device = device;
    this.format = format;
    this.reduced = prefersReducedMotion();
    this.count = model.points.length / 8;
    this.stats.points = this.count;
    this.anchors = model.manifest.anchors;
    this.initPipe = gpu.initPipe;
    this.stepPipe = gpu.stepPipe;
    this.pointsPipe = gpu.pointsPipe;
    this.flowPipe = gpu.flowPipe;
    this.prefilterPipe = gpu.prefilterPipe;
    this.downPipe = gpu.downPipe;
    this.upPipe = gpu.upPipe;
    this.compositePipe = gpu.compositePipe;
    this.postBgl = gpu.postBgl;
    this.compositeBgl = gpu.compositeBgl;
    this.prefilterBgl = gpu.prefilterBgl;

    const cam = model.manifest.camera;
    this.camera = new OrbitCamera(cam.position, cam.target, cam.fovDeg);
    this.camera.reduced = this.reduced;

    // Per-part runtime state.
    const exterior = new Uint8Array(model.parts.length);
    for (let i = 0; i < this.count; i++) {
      if (model.flags[i] & 1) exterior[model.points[i * 8 + 3]] = 1;
    }
    this.parts = model.parts.map(info => ({
      info, shell: info.kind === 'shell', hasExterior: !!exterior[info.id],
      r: 0.7, g: 0.75, b: 0.85, intensity: 1, activity: 0, pulse: 0, highlight: 0, slideT: 0, explodeT: 0, offset: [0, 0, 0] as Vec3,
    }));
    for (const p of this.parts) this.byKey.set(p.info.key, p);
    this.partData = new Float32Array(Math.max(1, model.parts.length) * 16);
    this.pData = new Float32Array(12);

    // Where the intro starts: just above the middle of the case, inside the default frame.
    const { min, max } = model.manifest.bounds;
    this.seed = [(min[0] + max[0]) / 2, max[1] + 0.04, (min[2] + max[2]) / 2];

    // Typical spacing of the points you see on the closed case: its surface area over its exterior
    // point count. The shader uses it to keep the picture from washing out when the canvas is small.
    let exteriorCount = 0;
    for (let i = 0; i < this.count; i++) if (model.flags[i] & 1) exteriorCount++;
    const dx = max[0] - min[0], dy = max[1] - min[1], dz = max[2] - min[2];
    this.spacing = Math.sqrt((2 * (dx * dy + dy * dz + dx * dz)) / Math.max(1, exteriorCount));

    const shellPart = model.parts.find(p => p.kind === 'shell');
    if (shellPart) {
      const pad = 0.004;
      this.shellBox.set([
        shellPart.center[0] - shellPart.size[0] / 2 - pad, shellPart.center[1] - shellPart.size[1] / 2 - pad, shellPart.center[2] - shellPart.size[2] / 2 - pad, 1,
        shellPart.center[0] + shellPart.size[0] / 2 + pad, shellPart.center[1] + shellPart.size[1] / 2 + pad, shellPart.center[2] + shellPart.size[2] / 2 + pad, 0,
      ]);
    }

    // What the camera must keep in frame: the closed case, and every part at its exploded position
    // (each part's own box, so the empty corners of one big box don't count).
    const corners = (m: Vec3, M: Vec3, offset: Vec3 = [0, 0, 0]): Vec3[] => {
      const out: Vec3[] = [];
      for (let i = 0; i < 8; i++) out.push([(i & 1 ? M[0] : m[0]) + offset[0], (i & 2 ? M[1] : m[1]) + offset[1], (i & 4 ? M[2] : m[2]) + offset[2]]);
      return out;
    };
    const exploded: Vec3[] = [];
    for (const info of model.parts) {
      // The shell lifts away as sparse dust: it only has to be mostly in frame (about 60% of its lift counts), so the parts can be larger.
      const k = info.kind === 'shell' ? 0.6 : 1;
      const m: Vec3 = [info.center[0] - info.size[0] / 2, info.center[1] - info.size[1] / 2, info.center[2] - info.size[2] / 2];
      const M: Vec3 = [info.center[0] + info.size[0] / 2, info.center[1] + info.size[1] / 2, info.center[2] + info.size[2] / 2];
      exploded.push(...corners(m, M, [info.explode[0] * k, info.explode[1] * k, info.explode[2] * k]));
    }
    this.camera.setBounds(corners(min, max), exploded);

    this.scene = {
      visuals: {}, defaultVisual: { color: [0.7, 0.75, 0.85], intensity: 1, activity: 0, pulse: 0, slide: 0 },
      exploded: false, xray: 0, selected: null, hovered: null,
    };

    // Static points: (x, y, z, part + 256 * flags), (nx, ny, nz, tone).
    const packed = new Float32Array(model.points);
    for (let i = 0; i < this.count; i++) packed[i * 8 + 3] = model.points[i * 8 + 3] + 256 * model.flags[i];
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.ptsBuf = device.createBuffer({ label: 'machine points', size: packed.byteLength, usage: storage });
    device.queue.writeBuffer(this.ptsBuf, 0, packed);
    this.stateBuf = device.createBuffer({ label: 'machine state', size: this.count * 32, usage: storage | GPUBufferUsage.COPY_SRC });   // COPY_SRC: dev read-back
    this.partsBuf = device.createBuffer({ label: 'machine parts', size: this.partData.byteLength, usage: storage });
    this.uniformBuf = device.createBuffer({ label: 'machine uniforms', size: this.uData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.flowBuf = device.createBuffer({ label: 'machine flows', size: this.flowData.byteLength, usage: storage });
    this.lutBuf = device.createBuffer({ label: 'machine flow paths', size: this.lutData.byteLength, usage: storage });
    this.postBuf = device.createBuffer({ label: 'machine post', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    activeEngine = this;
    // Dev only: a handle for the browser console (hot reloads give modules a new identity, so importing this file finds nothing).
    if (import.meta.env.DEV) (globalThis as { __machineEngine?: MachineEngine }).__machineEngine = this;

    this.simBind = device.createBindGroup({
      layout: gpu.simBgl,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: { buffer: this.ptsBuf } },
        { binding: 2, resource: { buffer: this.partsBuf } },
        { binding: 3, resource: { buffer: this.stateBuf } },
      ],
    });
    // The front screen: one texel per dot, filled from the view's canvas whenever its version changes.
    this.screenInfo = model.manifest.screen && model.byKey.get(model.manifest.screen.part)?.kind === 'screen' ? model.manifest.screen : null;
    this.screenTex = device.createTexture({
      label: 'machine screen',
      size: [Math.max(1, this.screenInfo?.cols ?? 1), Math.max(1, this.screenInfo?.rows ?? 1)],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.drawBind = device.createBindGroup({
      layout: gpu.drawBgl,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: { buffer: this.ptsBuf } },
        { binding: 2, resource: { buffer: this.partsBuf } },
        { binding: 3, resource: { buffer: this.stateBuf } },
        { binding: 4, resource: { buffer: this.flowBuf } },
        { binding: 5, resource: { buffer: this.lutBuf } },
        { binding: 6, resource: this.screenTex.createView() },
      ],
    });
  }

  // ---------- inputs from the component ----------

  setScene(scene: SceneState) {
    this.scene = scene;
  }

  setFlows(flows: Flow[]) {
    const seen = new Set<string>();
    for (const flow of flows.slice(0, MAX_FLOWS)) {
      seen.add(flow.id);
      let rt = this.flows.get(flow.id);
      if (!rt) {
        rt = { id: flow.id, flow, alive: true, rate: 0, r: 1, g: 1, b: 1, phase: Math.random(), length: 0.2, valid: false, first: 0, count: 0 };
        rt.r = srgbToLinear(flow.color[0]); rt.g = srgbToLinear(flow.color[1]); rt.b = srgbToLinear(flow.color[2]);
        this.flows.set(flow.id, rt);
        this.flowLayoutDirty = true;
      }
      rt.flow = flow;
      rt.alive = true;
    }
    for (const rt of this.flows.values()) if (!seen.has(rt.id)) rt.alive = false;
    this.flowsDirty = true;
  }

  // The view's screen canvas (cols x rows pixels, one per dot) and its version. Re-uploaded only
  // when either changes. Without it the screen part draws as ordinary body points.
  setScreen(canvas: HTMLCanvasElement | null, version: number) {
    if (!this.screenInfo) return;
    if (canvas === this.screenCanvas && version === this.screenVersion && !this.screenPending) return;
    this.screenCanvas = canvas;
    this.screenVersion = version;
    this.screenPending = !!canvas;
    this.uploadScreen();
  }

  // A canvas that has not been drawn on yet has no context and can't be copied: try again next frame.
  private uploadScreen() {
    const canvas = this.screenCanvas;
    if (!canvas || !this.screenInfo) { this.screenPending = false; return; }
    const w = Math.min(this.screenInfo.cols, canvas.width), h = Math.min(this.screenInfo.rows, canvas.height);
    if (w < 1 || h < 1) { this.screenPending = false; return; }
    try {
      this.device.queue.copyExternalImageToTexture({ source: canvas }, { texture: this.screenTex, premultipliedAlpha: false }, [w, h]);
      this.screenPending = false;
    } catch {
      this.screenPending = true;
    }
  }

  setPointer(x: number | null, y?: number) {
    this.pointer = x === null ? null : { x, y: y ?? 0 };
  }
  // While the user is dragging the camera the pointer should not push points around.
  suppressPointer(on: boolean) { this.pointerSuppressed = on; }

  // The part under a point of the canvas (CSS pixels), if any.
  pick(x: number, y: number): { key: string; t: number } | null {
    const { origin, dir } = this.camera.ray(x, y, this.cssW, this.cssH);
    const open = this.openAmount();
    let best: { key: string; t: number } | null = null;
    let shell: { key: string; t: number } | null = null;
    for (const p of this.parts) {
      if (p.intensity < 0.04) continue;
      if (p.shell) {
        if (open > 0.5) continue;
      } else if (!p.hasExterior && p.info.kind !== 'screen' && open < 0.35) {
        continue;
      }
      const c = p.info.center, s = p.info.size, o = p.offset;
      const pad = p.info.kind === 'screen' ? 0.006 : 0.003;
      const min: Vec3 = [c[0] + o[0] - s[0] / 2 - pad, c[1] + o[1] - s[1] / 2 - pad, c[2] + o[2] - s[2] / 2 - pad];
      const max: Vec3 = [c[0] + o[0] + s[0] / 2 + pad, c[1] + o[1] + s[1] / 2 + pad, c[2] + o[2] + s[2] / 2 + pad];
      const t = rayBox(origin, dir, min, max);
      if (t < 0) continue;
      if (p.shell) shell = { key: p.info.key, t };
      else if (!best || t < best.t) best = { key: p.info.key, t };
    }
    return best ?? shell;
  }

  // Is the pointer over the machine: any part's box (at its current offset, a centimetre of slack)?
  // Used to hold the idle sway still while you look at it.
  private overMachine(x: number, y: number): boolean {
    const { origin, dir } = this.camera.ray(x, y, this.cssW, this.cssH);
    const pad = 0.01;
    for (const p of this.parts) {
      const c = p.info.center, s = p.info.size, o = p.offset;
      const min: Vec3 = [c[0] + o[0] - s[0] / 2 - pad, c[1] + o[1] - s[1] / 2 - pad, c[2] + o[2] - s[2] / 2 - pad];
      const max: Vec3 = [c[0] + o[0] + s[0] / 2 + pad, c[1] + o[1] + s[1] / 2 + pad, c[2] + o[2] + s[2] / 2 + pad];
      if (rayBox(origin, dir, min, max) >= 0) return true;
    }
    return false;
  }

  // World anchor of a part (with its current offset) in CSS pixels on the canvas.
  project(key: string, at: LabelAt = 'socket'): { x: number; y: number; visible: boolean } | null {
    const p = this.byKey.get(key);
    if (!p) return null;
    const { center, size, socket } = p.info;
    const base: Vec3 = at === 'center' ? center : at === 'top' ? [center[0], center[1] + size[1] / 2, center[2]] : socket;
    const world: Vec3 = [base[0] + p.offset[0], base[1] + p.offset[1], base[2] + p.offset[2]];
    const r = this.camera.project(world, this.cssW, this.cssH);
    const inside = r.x > -40 && r.x < this.cssW + 40 && r.y > -40 && r.y < this.cssH + 40;
    return { x: r.x, y: r.y, visible: r.visible && inside };
  }

  get size() { return { width: this.cssW, height: this.cssH }; }

  // Camera input. Times are the engine's own clock so the idle sway can tell when you stopped.
  private now() { return Math.max(this.lastTime, 0); }
  orbitStart() { this.camera.dragStart(this.now()); }
  orbit(dx: number, dy: number, dt: number) { this.camera.drag(dx, dy, dt, this.now()); }
  orbitEnd() { this.camera.dragEnd(this.now()); }
  zoom(factor: number) { this.camera.zoom(factor, this.now()); }
  nudge(dyaw: number, dpitch: number) { this.camera.nudge(dyaw, dpitch, this.now()); }
  resetCamera() { this.camera.reset(this.now()); }
  // Dev aid: look at a part (its centre), or back at the whole machine with null.
  focusOn(key: string | null) {
    const p = key ? this.byKey.get(key) : null;
    this.camera.focus(p ? [p.info.center[0] + p.offset[0], p.info.center[1] + p.offset[1], p.info.center[2] + p.offset[2]] : null);
  }

  // The screen counts as live once the view has given us something to show.
  private screenLive() { return this.screenInfo && this.screenCanvas ? this.screenInfo : null; }

  private openAmount() { return Math.max(this.xrayCur, this.explodeCur); }

  // ---------- Renderer ----------

  resize(width: number, height: number, dpr: number) {
    this.cssW = Math.max(1, width);
    this.cssH = Math.max(1, height);
    this.dpr = dpr;
    this.camera.aspect = this.cssW / this.cssH;
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (w === this.devW && h === this.devH && this.sceneTex) return;
    this.devW = w;
    this.devH = h;
    this.buildTargets();
  }

  private buildTargets() {
    const { device } = this;
    this.sceneTex?.destroy();
    this.flowTex?.destroy();
    this.mips.forEach(t => t.destroy());
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.sceneTex = device.createTexture({ label: 'machine scene', size: [this.devW, this.devH], format: HDR, usage });
    this.sceneView = this.sceneTex.createView();
    this.flowTex = device.createTexture({ label: 'machine flows', size: [this.devW, this.devH], format: HDR, usage });
    this.flowView = this.flowTex.createView();
    this.mips = [];
    this.mipViews = [];
    for (let l = 0; l < BLOOM_LEVELS; l++) {
      const w = Math.max(1, this.devW >> (l + 1)), h = Math.max(1, this.devH >> (l + 1));
      const tex = device.createTexture({ label: `machine bloom ${l}`, size: [w, h], format: HDR, usage });
      this.mips.push(tex);
      this.mipViews.push(tex.createView());
    }
    const bind = (view: GPUTextureView) => device.createBindGroup({
      layout: this.postBgl,
      entries: [
        { binding: 0, resource: view },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.postBuf } },
      ],
    });
    this.downBinds = this.mipViews.slice(0, -1).map(bind);
    this.prefilterBind = device.createBindGroup({
      layout: this.prefilterBgl,
      entries: [
        { binding: 0, resource: this.sceneView },
        { binding: 1, resource: this.flowView },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: { buffer: this.postBuf } },
      ],
    });
    this.upBinds = this.mipViews.map((_, l) => (l + 1 < BLOOM_LEVELS ? bind(this.mipViews[l + 1]) : bind(this.mipViews[l])));
    this.compositeBind = device.createBindGroup({
      layout: this.compositeBgl,
      entries: [
        { binding: 0, resource: this.sceneView },
        { binding: 1, resource: this.flowView },
        { binding: 2, resource: this.mipViews[0] },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: { buffer: this.postBuf } },
      ],
    });
  }

  encode(encoder: GPUCommandEncoder, canvasView: GPUTextureView, rawTime: number): boolean {
    this.lastRaw = rawTime;
    if (this.paused) return true;
    return this.render(encoder, canvasView, rawTime + this.offset);
  }

  private render(encoder: GPUCommandEncoder, canvasView: GPUTextureView, time: number): boolean {
    if (!this.sceneView || !this.compositeBind) return true;
    const t0 = performance.now();
    const dt = this.lastTime < 0 ? 0 : Math.min(Math.max(time - this.lastTime, 0), 1 / 20);
    if (this.lastTime >= 0 && time > this.lastTime) {
      const inst = 1 / (time - this.lastTime);
      this.fpsEma += (Math.min(inst, 240) - this.fpsEma) * 0.05;
      this.stats.fps = this.fpsEma;
    }
    this.lastTime = time;
    if (this.introStart < 0) this.introStart = this.reduced ? -1000 : time + 0.15;

    if (this.screenPending) this.uploadScreen();
    this.camera.update(dt, time);
    this.updateParts(dt);
    this.updateFlows(dt);
    this.updatePointer(dt);
    this.camera.setHover(this.pointer !== null && this.overMachine(this.pointer.x, this.pointer.y));
    this.onFrame?.(this);
    this.writeUniforms(time, dt);
    this.recordPasses(encoder, canvasView);
    this.stats.cpuMs += (performance.now() - t0 - this.stats.cpuMs) * 0.1;
    return true;
  }

  // ---------- per-frame CPU work ----------

  private updateParts(dt: number) {
    const s = this.scene;
    const kFast = 1 - Math.exp(-dt / 0.12);
    const kColor = 1 - Math.exp(-dt / 0.2);
    const kMid = 1 - Math.exp(-dt / 0.35);
    const kMove = 1 - Math.exp(-dt / 0.32);
    this.xrayCur += (Math.min(1, Math.max(0, s.xray)) - this.xrayCur) * (1 - Math.exp(-dt / 0.2));
    this.explodeCur += ((s.exploded ? 1 : 0) - this.explodeCur) * kMove;
    if (Math.abs(this.explodeCur - (s.exploded ? 1 : 0)) < 1e-4) this.explodeCur = s.exploded ? 1 : 0;
    this.camera.setExplode(this.explodeCur);
    const dimOthers = s.selected && this.byKey.has(s.selected) ? 0.5 : 1;

    for (const p of this.parts) {
      const key = p.info.key;
      const v = s.visuals[key] ?? s.defaultVisual;
      p.r += (srgbToLinear(v.color[0]) - p.r) * kColor;
      p.g += (srgbToLinear(v.color[1]) - p.g) * kColor;
      p.b += (srgbToLinear(v.color[2]) - p.b) * kColor;
      p.intensity += (v.intensity * (key === s.selected ? 1 : dimOthers) - p.intensity) * kColor;
      p.activity += (v.activity - p.activity) * kMid;
      p.pulse += (v.pulse - p.pulse) * kMid;
      p.highlight += ((key === s.selected ? 1 : key === s.hovered ? 0.7 : 0) - p.highlight) * kFast;

      const slideTarget = p.info.slide ? v.slide : 0;
      const prevSlide = p.slideT, prevExplode = p.explodeT;
      p.slideT += (slideTarget - p.slideT) * kMove;
      if (Math.abs(p.slideT - slideTarget) < 1e-4) p.slideT = slideTarget;
      p.explodeT = this.explodeCur;
      if (p.slideT !== prevSlide || p.explodeT !== prevExplode) this.partsMoved = true;

      const sl = p.info.slide ?? ZERO, ex = p.info.explode;
      p.offset[0] = sl[0] * p.slideT + ex[0] * p.explodeT;
      p.offset[1] = sl[1] * p.slideT + ex[1] * p.explodeT;
      p.offset[2] = sl[2] * p.slideT + ex[2] * p.explodeT;
    }
  }

  private updatePointer(dt: number) {
    const on = this.pointer !== null && !this.pointerSuppressed && !this.camera.busy && !this.reduced;
    this.pointerStrength += ((on ? 1 : 0) - this.pointerStrength) * (1 - Math.exp(-dt / 0.08));
  }

  private resolve(name: string): Vec3 | null {
    const p = this.byKey.get(name);
    if (p) return [p.info.socket[0] + p.offset[0], p.info.socket[1] + p.offset[1], p.info.socket[2] + p.offset[2]];
    const a = this.anchors[name];
    return a ? [a[0], a[1], a[2]] : null;
  }

  private updateFlows(dt: number) {
    const kRate = 1 - Math.exp(-dt / 0.45);
    const kColor = 1 - Math.exp(-dt / 0.25);
    let changed = false;
    for (const rt of this.flows.values()) {
      const target = rt.alive ? Math.min(1, Math.max(0, rt.flow.rate)) : 0;
      rt.rate += (target - rt.rate) * kRate;
      if (rt.alive) {
        rt.r += (srgbToLinear(rt.flow.color[0]) - rt.r) * kColor;
        rt.g += (srgbToLinear(rt.flow.color[1]) - rt.g) * kColor;
        rt.b += (srgbToLinear(rt.flow.color[2]) - rt.b) * kColor;
      }
      const speed = (0.05 + 0.3 * Math.pow(rt.rate, 0.8)) * (this.reduced ? 0.35 : 1);
      rt.phase = (rt.phase + (dt * speed) / Math.max(rt.length, 0.02)) % 1;
      if (!rt.alive && rt.rate < 0.004) { this.flows.delete(rt.id); changed = true; }
    }
    if (changed) this.flowLayoutDirty = true;

    if (this.flowLayoutDirty) {
      // Live flows first. Anything over the limit (new flows arriving while others fade out) is dropped.
      const all = [...this.flows.values()].sort((a, b) => Number(b.alive) - Number(a.alive));
      for (const rt of all.slice(MAX_FLOWS)) this.flows.delete(rt.id);
      this.flowOrder = all.slice(0, MAX_FLOWS);
      const per = Math.min(MAX_PER_FLOW, Math.floor(FLOW_PARTICLES / Math.max(1, this.flowOrder.length)));
      this.flowOrder.forEach((rt, i) => { rt.first = i * per; rt.count = per; });
      this.stats.flowParticles = this.flowOrder.length * per;
      this.flowLayoutDirty = false;
      this.flowsDirty = true;
    }
    if (this.flowsDirty || this.partsMoved) {
      this.flowOrder.forEach((rt, slot) => this.buildPath(rt, slot));
      this.device.queue.writeBuffer(this.lutBuf, 0, this.lutData);
      this.flowsDirty = false;
    }
    this.partsMoved = false;

    this.flowOrder.forEach((rt, slot) => {
      const o = slot * 12;
      // About 2200 particles per metre of path at full rate: dense enough to read as a stream, sparse enough that each head stays distinct.
      const frac = !rt.valid || rt.rate < 0.003 ? 0 : Math.min(1, (2200 * Math.pow(rt.rate, 0.9) * rt.length + 16) / rt.count);
      const gain = 3.0 + 1.5 * rt.rate;
      this.flowData.set([
        rt.r, rt.g, rt.b, gain,
        rt.first, rt.count, slot * LUT_N, frac,
        rt.phase, 0.003 + 0.004 * rt.rate, 8 + 16 * rt.rate, 0,
      ], o);
    });
    this.device.queue.writeBuffer(this.flowBuf, 0, this.flowData);
  }

  // Smooth path from -> via... -> to through sockets and anchors (Hermite with unit-length
  // tangents scaled per segment, so uneven spacing can't overshoot), resampled by arc length.
  private buildPath(rt: FlowRuntime, slot: number) {
    const names = [rt.flow.from, ...rt.flow.via, rt.flow.to];
    const pts: Vec3[] = [];
    for (const n of names) {
      const p = this.resolve(n);
      if (p) pts.push(p);
    }
    rt.valid = pts.length >= 2;
    if (!rt.valid) return;
    const tan = pts.map((_, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const l = Math.hypot(d[0], d[1], d[2]) || 1;
      return [d[0] / l, d[1] / l, d[2] / l] as Vec3;
    });
    const dense: Vec3[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i], p1 = pts[i + 1];
      const seg = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
      for (let k = 0; k < 24; k++) {
        const t = k / 24, t2 = t * t, t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
        dense.push([
          h00 * p0[0] + h10 * seg * tan[i][0] + h01 * p1[0] + h11 * seg * tan[i + 1][0],
          h00 * p0[1] + h10 * seg * tan[i][1] + h01 * p1[1] + h11 * seg * tan[i + 1][1],
          h00 * p0[2] + h10 * seg * tan[i][2] + h01 * p1[2] + h11 * seg * tan[i + 1][2],
        ]);
      }
    }
    dense.push(pts[pts.length - 1]);
    const cum = [0];
    for (let i = 1; i < dense.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1], dense[i][2] - dense[i - 1][2]));
    }
    const total = cum[cum.length - 1] || 1e-3;
    rt.length = total;
    let j = 0;
    const base = slot * LUT_N * 4;
    for (let n = 0; n < LUT_N; n++) {
      const target = (n / (LUT_N - 1)) * total;
      while (j < cum.length - 2 && cum[j + 1] < target) j++;
      const span = cum[j + 1] - cum[j] || 1;
      const f = Math.min(1, Math.max(0, (target - cum[j]) / span));
      const a = dense[j], b = dense[j + 1];
      this.lutData[base + n * 4] = a[0] + (b[0] - a[0]) * f;
      this.lutData[base + n * 4 + 1] = a[1] + (b[1] - a[1]) * f;
      this.lutData[base + n * 4 + 2] = a[2] + (b[2] - a[2]) * f;
      this.lutData[base + n * 4 + 3] = 0;
    }
  }

  // ---------- GPU uploads and passes ----------

  private writeUniforms(time: number, dt: number) {
    const f = this.camera.frame;
    const u = this.uData;
    u.set(f.viewProj, 0);
    u.set([f.eye[0], f.eye[1], f.eye[2], time], 16);
    u.set([f.right[0], f.right[1], f.right[2], dt], 20);
    u.set([f.up[0], f.up[1], f.up[2], this.count], 24);
    // Key light from the upper left of the view, slightly in front.
    const L: Vec3 = [
      -0.85 * f.right[0] + 0.72 * f.up[0] - 0.5 * f.forward[0],
      -0.85 * f.right[1] + 0.72 * f.up[1] - 0.5 * f.forward[1],
      -0.85 * f.right[2] + 0.72 * f.up[2] - 0.5 * f.forward[2],
    ];
    const ll = Math.hypot(L[0], L[1], L[2]);
    u.set([L[0] / ll, L[1] / ll, L[2] / ll, this.openAmount()], 28);
    const sizeScale = Math.min(1.5, Math.max(0.85, this.devH / 1000)) * this.tuning.pointSize;
    u.set([this.devW, this.devH, this.dpr, sizeScale], 32);
    u.set([this.xrayCur, this.reduced ? 1 : 0, this.introStart, INTRO_SECONDS], 36);
    u.set([this.seed[0], this.seed[1], this.seed[2], 0], 40);

    let active = this.pointerStrength;
    let origin: Vec3 = [0, 0, 0], dir: Vec3 = [0, 0, 1], focus = f.distance;
    if (this.pointer && active > 0.001) {
      const ray = this.camera.ray(this.pointer.x, this.pointer.y, this.cssW, this.cssH);
      origin = ray.origin; dir = ray.dir;
      const hit = this.pick(this.pointer.x, this.pointer.y);
      if (hit) focus = hit.t;
    } else {
      active = 0;
    }
    u.set([origin[0], origin[1], origin[2], active], 44);
    u.set([dir[0], dir[1], dir[2], focus], 48);
    u.set([this.tuning.repelRadius, this.tuning.repelStrength, this.reduced ? 0 : 0.0007, this.reduced ? 0 : 0.0012], 52);
    u.set([this.flowOrder.length, f.distance, this.stats.flowParticles, this.explodeCur], 56);
    u.set([f.forward[0], f.forward[1], f.forward[2], f.tanHalfFov], 60);
    // Points per pixel: screen pixels per metre at the target, times the point spacing, against
    // the density the look was tuned at (about 6 px between points).
    const pxPerMetre = this.devH / (2 * f.distance * f.tanHalfFov);
    u.set([f.target[0], f.target[1], f.target[2], (pxPerMetre * this.spacing) / 6.4], 64);
    const sc = this.screenLive();
    if (sc) u.set([sc.origin[0], sc.origin[1], sc.origin[2], sc.cols, sc.u[0], sc.u[1], sc.u[2], sc.rows, sc.v[0], sc.v[1], sc.v[2], 1], 68);
    else u.fill(0, 68, 80);
    u.set(this.shellBox, 80);
    this.device.queue.writeBuffer(this.uniformBuf, 0, u);

    // Parts.
    const pd = this.partData;
    this.parts.forEach((p, i) => {
      const o = i * 16;
      pd[o] = p.r; pd[o + 1] = p.g; pd[o + 2] = p.b; pd[o + 3] = Math.max(0, p.intensity);
      pd[o + 4] = p.activity; pd[o + 5] = p.pulse; pd[o + 6] = p.highlight; pd[o + 7] = p.shell ? 1 : sc && p.info.key === sc.part ? 2 : 0;
      const sl = p.info.slide ?? [0, 0, 0];
      pd[o + 8] = sl[0]; pd[o + 9] = sl[1]; pd[o + 10] = sl[2]; pd[o + 11] = p.slideT;
      const ex = p.info.explode;
      pd[o + 12] = ex[0]; pd[o + 13] = ex[1]; pd[o + 14] = ex[2]; pd[o + 15] = p.explodeT;
    });
    this.device.queue.writeBuffer(this.partsBuf, 0, pd);

    const tn = this.tuning;
    this.pData.set([tn.bloom, tn.exposure, tn.vignette, tn.grain, time, tn.threshold, tn.knee, tn.upGain, tn.flowLimit, tn.flowBloom, tn.screenBloom, 0]);
    this.device.queue.writeBuffer(this.postBuf, 0, this.pData);
  }

  private recordPasses(encoder: GPUCommandEncoder, canvasView: GPUTextureView) {
    const groups = Math.ceil(this.count / 64);
    const cp = encoder.beginComputePass({ label: 'machine sim' });
    cp.setBindGroup(0, this.simBind);
    if (!this.initialised) {
      cp.setPipeline(this.initPipe);
      cp.dispatchWorkgroups(groups);
      this.initialised = true;
    }
    cp.setPipeline(this.stepPipe);
    cp.dispatchWorkgroups(groups);
    cp.end();

    const scene = encoder.beginRenderPass({
      label: 'machine scene',
      colorAttachments: [
        { view: this.sceneView!, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
        { view: this.flowView!, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
      ],
    });
    scene.setBindGroup(0, this.drawBind);
    scene.setPipeline(this.pointsPipe);
    scene.draw(4, this.count);
    if (this.flowOrder.length > 0) {
      scene.setPipeline(this.flowPipe);
      scene.draw(4, this.flowOrder.length * this.flowOrder[0].count);
    }
    scene.end();

    // Bloom: scene -> mip 0 (threshold) -> ... -> mip N-1, then back up, adding as we go.
    this.fullscreen(encoder, this.prefilterPipe, this.prefilterBind!, this.mipViews[0], false);
    for (let l = 1; l < BLOOM_LEVELS; l++) this.fullscreen(encoder, this.downPipe, this.downBinds[l - 1], this.mipViews[l], false);
    for (let l = BLOOM_LEVELS - 2; l >= 0; l--) this.fullscreen(encoder, this.upPipe, this.upBinds[l], this.mipViews[l], true);

    const out = encoder.beginRenderPass({
      label: 'machine composite',
      colorAttachments: [{ view: canvasView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    out.setPipeline(this.compositePipe);
    out.setBindGroup(0, this.compositeBind!);
    out.draw(3);
    out.end();
  }

  private fullscreen(encoder: GPUCommandEncoder, pipeline: GPURenderPipeline, bind: GPUBindGroup, target: GPUTextureView, load: boolean) {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
  }

  // Dev aid: render `frames` frames back to back into an offscreen target and report the
  // average time per frame (GPU-bound when the GPU is the bottleneck).
  async benchmark(frames = 60): Promise<number> {
    const target = this.device.createTexture({ size: [this.devW, this.devH], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const view = target.createView();
    const run = async (n: number) => {
      for (let i = 0; i < n; i++) {
        const encoder = this.device.createCommandEncoder();
        this.render(encoder, view, this.lastTime + 1 / 60);
        this.device.queue.submit([encoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();
      }
    };
    this.paused = true;
    await run(5);
    const t0 = performance.now();
    await run(frames);
    const ms = (performance.now() - t0) / frames;
    this.offset = this.lastTime - this.lastRaw;
    this.paused = false;
    target.destroy();
    return ms;
  }

  // Dev aid: step the simulation `seconds` forward at `fps` without waiting for animation
  // frames (a hidden browser pane doesn't deliver them). The live loop continues from there.
  async advance(seconds: number, fps = 60): Promise<void> {
    const target = this.device.createTexture({ size: [16, 16], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const view = target.createView();
    const n = Math.round(seconds * fps);
    for (let i = 0; i < 50 && !this.sceneView; i++) await new Promise(r => setTimeout(r, 100));
    if (this.lastTime < 0) this.lastTime = 0;
    this.paused = true;
    for (let i = 0; i < n; i++) {
      const encoder = this.device.createCommandEncoder();
      this.render(encoder, view, this.lastTime + 1 / fps);
      this.device.queue.submit([encoder.finish()]);
      if (i % 20 === 19) await this.device.queue.onSubmittedWorkDone();
    }
    await this.device.queue.onSubmittedWorkDone();
    this.offset = this.lastTime - this.lastRaw;
    this.paused = false;
    target.destroy();
  }

  // Dev aid: the current frame at device resolution as a PNG, for judging the look pixel by pixel.
  async capture(): Promise<Blob> {
    const { devW: w, devH: h } = this;
    const target = this.device.createTexture({ size: [w, h], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
    const buffer = this.device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.device.createCommandEncoder();
    this.render(encoder, target.createView(), this.lastTime);   // same time: dt is 0, nothing moves
    encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow }, [w, h]);
    this.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buffer.getMappedRange());
    const image = new ImageData(w, h);
    const swap = this.format.startsWith('bgra');
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = y * bytesPerRow + x * 4, d = (y * w + x) * 4;
        image.data[d] = src[s + (swap ? 2 : 0)];
        image.data[d + 1] = src[s + 1];
        image.data[d + 2] = src[s + (swap ? 0 : 2)];
        image.data[d + 3] = 255;
      }
    }
    buffer.unmap();
    buffer.destroy();
    target.destroy();
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.putImageData(image, 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
  }

  destroy() {
    if (activeEngine === this) activeEngine = null;
    if (import.meta.env.DEV && (globalThis as { __machineEngine?: MachineEngine }).__machineEngine === this) delete (globalThis as { __machineEngine?: MachineEngine }).__machineEngine;
    for (const b of [this.ptsBuf, this.stateBuf, this.partsBuf, this.uniformBuf, this.flowBuf, this.lutBuf, this.postBuf]) b.destroy();
    this.sceneTex?.destroy();
    this.flowTex?.destroy();
    this.screenTex.destroy();
    this.mips.forEach(t => t.destroy());
  }
}
