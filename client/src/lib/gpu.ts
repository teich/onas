// WebGPU plumbing shared by the visualizations: one device, canvases sized in device pixels,
// a render loop that sleeps when the canvas is off-screen or the tab is hidden, and shader
// errors surfaced to the page instead of the console.
import { useEffect, useRef, useState } from 'react';

export interface Gpu {
  device: GPUDevice;
  format: GPUTextureFormat;
}

export class GpuUnavailable extends Error {}

let gpuPromise: Promise<Gpu> | null = null;

export function getGpu(): Promise<Gpu> {
  if (!gpuPromise) {
    gpuPromise = (async () => {
      if (!navigator.gpu) {
        throw new GpuUnavailable(window.isSecureContext
          ? 'This browser has no WebGPU. onas targets current Safari.'
          : 'WebGPU only runs on HTTPS. Open https://onas.giraffe-gamma.ts.net');
      }
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw new GpuUnavailable('No WebGPU adapter is available.');
      const device = await adapter.requestDevice();
      device.lost.then(() => { gpuPromise = null; });
      return { device, format: navigator.gpu.getPreferredCanvasFormat() };
    })();
    gpuPromise.catch(() => { gpuPromise = null; });
  }
  return gpuPromise;
}

// Compile WGSL and throw with line numbers if it doesn't compile.
export async function shaderModule(device: GPUDevice, label: string, code: string): Promise<GPUShaderModule> {
  const module = device.createShaderModule({ label, code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter(m => m.type === 'error');
  if (errors.length) throw new Error(`${label}: ${errors.map(e => `line ${e.lineNum}: ${e.message}`).join('; ')}`);
  return module;
}

export function alphaBlend(format: GPUTextureFormat): GPUColorTargetState {
  return {
    format,
    blend: {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    },
  };
}

// Write data into a buffer, growing it when needed. Returns the (possibly new) buffer.
export function upload(device: GPUDevice, buffer: GPUBuffer | null, data: Float32Array | Uint32Array, usage: GPUBufferUsageFlags, label: string): GPUBuffer {
  const size = Math.max(16, Math.ceil(data.byteLength / 16) * 16);
  if (!buffer || buffer.size < size) {
    buffer?.destroy();
    buffer = device.createBuffer({ label, size: Math.max(size, (buffer?.size ?? 0) * 2), usage: usage | GPUBufferUsage.COPY_DST });
  }
  device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
  return buffer;
}

export interface Renderer {
  // Called with the canvas size in CSS pixels and the device pixel ratio.
  resize(width: number, height: number, dpr: number): void;
  // Draw one frame into a render pass on the canvas. Return true to keep animating, false to
  // sleep until invalidate(). Implement this or encode().
  frame?(pass: GPURenderPassEncoder, timeSeconds: number): boolean;
  // Multi-pass alternative to frame(): record whatever passes you need (compute, offscreen
  // targets, post-processing) and finish by writing to `canvasView`. When present it is used
  // instead of frame(). Same return value.
  encode?(encoder: GPUCommandEncoder, canvasView: GPUTextureView, timeSeconds: number): boolean;
  destroy?(): void;
}

export interface GpuCanvasHandle {
  invalidate(): void;
}

// Runs a Renderer on a canvas. `create` is called once the device is ready; `deps` rebuild it.
export function useGpuCanvas<R extends Renderer>(
  create: (gpu: Gpu) => Promise<R>,
  deps: unknown[],
): { canvasRef: React.RefObject<HTMLCanvasElement>; renderer: R | null; error: string | null; handle: GpuCanvasHandle } {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderer, setRenderer] = useState<R | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wake = useRef<() => void>(() => {});
  const handle = useRef<GpuCanvasHandle>({ invalidate: () => wake.current() }).current;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let raf = 0;
    let visible = true;
    let current: R | null = null;
    let context: GPUCanvasContext | null = null;
    let device: GPUDevice | null = null;
    const start = performance.now();

    const draw = () => {
      raf = 0;
      if (disposed || !current || !context || !device || !visible || document.hidden) return;
      if (canvas.width === 0 || canvas.height === 0) return;
      const encoder = device.createCommandEncoder();
      const view = context.getCurrentTexture().createView();
      const seconds = (performance.now() - start) / 1000;
      let again = false;
      if (current.encode) {
        again = current.encode(encoder, view, seconds);
      } else if (current.frame) {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
        });
        again = current.frame(pass, seconds);
        pass.end();
      }
      device.queue.submit([encoder.finish()]);
      if (again) raf = requestAnimationFrame(draw);
    };
    const request = () => { if (!raf) raf = requestAnimationFrame(draw); };
    wake.current = request;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      current?.resize(rect.width, rect.height, dpr);
      request();
    };
    const resizeObserver = new ResizeObserver(resize);
    const intersection = new IntersectionObserver(entries => {
      visible = entries.some(e => e.isIntersecting);
      if (visible) request();
    });
    const onVisibility = () => { if (!document.hidden) request(); };

    getGpu().then(async gpu => {
      device = gpu.device;
      device.onuncapturederror = event => setError(event.error.message);
      context = canvas.getContext('webgpu');
      if (!context) throw new GpuUnavailable('Could not get a WebGPU canvas context.');
      context.configure({ device, format: gpu.format, alphaMode: 'premultiplied' });
      const r = await create(gpu);
      if (disposed) { r.destroy?.(); return; }
      current = r;
      setRenderer(r);
      setError(null);
      resizeObserver.observe(canvas);
      intersection.observe(canvas);
      document.addEventListener('visibilitychange', onVisibility);
      resize();
    }).catch(err => { if (!disposed) setError((err as Error).message); });

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersection.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      current?.destroy?.();
      setRenderer(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { canvasRef, renderer, error, handle };
}

// Shared WGSL: colour helpers used by every visualization.
export const WGSL_COMMON = /* wgsl */ `
fn srgb_to_linear(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}
fn linear_to_oklab(c: vec3f) -> vec3f {
  let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  let l_ = pow(l, 1.0 / 3.0); let m_ = pow(m, 1.0 / 3.0); let s_ = pow(s, 1.0 / 3.0);
  return vec3f(0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
               1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
               0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_);
}
fn oklab_to_linear(c: vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  let l = l_ * l_ * l_; let m = m_ * m_ * m_; let s = s_ * s_ * s_;
  return vec3f(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
              -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
              -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
fn linear_to_srgb(c: vec3f) -> vec3f {
  let x = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
}
// Perceptual mix of two sRGB colours.
fn mix_oklab(a: vec3f, b: vec3f, t: f32) -> vec3f {
  return linear_to_srgb(oklab_to_linear(mix(linear_to_oklab(srgb_to_linear(a)), linear_to_oklab(srgb_to_linear(b)), t)));
}
`;

// "#3987e5" -> [r, g, b] in 0..1 (sRGB)
export function hex(color: string): [number, number, number] {
  const v = parseInt(color.replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
