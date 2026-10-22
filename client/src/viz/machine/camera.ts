// Orbit camera for the Machine scene: perspective from the manifest's default shot, drag to
// orbit with inertia, wheel and pinch zoom, a slow idle sway, plus the matrices and rays the
// engine needs. Column-major Float32Array matrices, WebGPU clip space (z in 0..1).
import type { Vec3 } from './types';

export type Mat4 = Float32Array;

const DEG = Math.PI / 180;
const PITCH_MIN = -5 * DEG;
const PITCH_MAX = 70 * DEG;

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (far * near) / (near - far);
  return m;
}

export function lookAt(eye: Vec3, target: Vec3, up: Vec3): { view: Mat4; right: Vec3; up: Vec3; forward: Vec3 } {
  let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2];
  let l = Math.hypot(fx, fy, fz) || 1;
  fx /= l; fy /= l; fz /= l;
  let rx = fy * up[2] - fz * up[1], ry = fz * up[0] - fx * up[2], rz = fx * up[1] - fy * up[0];
  l = Math.hypot(rx, ry, rz) || 1;
  rx /= l; ry /= l; rz /= l;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  const m = new Float32Array(16);
  m[0] = rx; m[1] = ux; m[2] = -fx;
  m[4] = ry; m[5] = uy; m[6] = -fy;
  m[8] = rz; m[9] = uz; m[10] = -fz;
  m[12] = -(rx * eye[0] + ry * eye[1] + rz * eye[2]);
  m[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
  m[14] = fx * eye[0] + fy * eye[1] + fz * eye[2];
  m[15] = 1;
  return { view: m, right: [rx, ry, rz], up: [ux, uy, uz], forward: [fx, fy, fz] };
}

export function multiply(a: Mat4, b: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export interface CameraFrame {
  eye: Vec3;
  target: Vec3;
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  viewProj: Mat4;
  distance: number;
  tanHalfFov: number;
  aspect: number;
}

interface Fit { distance: number; shift: Vec3 }

const wrapPi = (a: number) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));

export class OrbitCamera {
  private target: Vec3;
  private fov: number;
  private baseYaw: number;
  private basePitch: number;
  private yaw: number;
  private pitch: number;
  private zoomFactor = 1;      // the user's zoom, relative to the fitted view
  private yawVel = 0;
  private pitchVel = 0;
  private resetting = false;
  private dragging = false;
  private lastTouch = -100;     // seconds; sway starts a few seconds after this
  private sway = 0;             // 0..1 amplitude of the idle sway
  private swayRate = 0;         // 0..1 how fast its phase runs: eased, so the sway coasts to a stop
  private hovering = false;
  private hoverEnd = -100;      // seconds; the pointer was last over the machine
  private swayPhase = 0;
  reduced = false;
  // Where the model should sit: the share of the canvas's limiting dimension its bounds fill.
  fill = 0.7;
  private aspectRatio = 1.6;
  // The fitted view (distance and look-at shift) for the closed and the exploded model, blended
  // by how far the explode has got. Recomputed whenever the canvas shape changes.
  private restBounds: Vec3[] = [];
  private explodedBounds: Vec3[] = [];
  private fitRest: Fit;
  private fitExploded: Fit;
  private explode = 0;
  private focusWant: Vec3 | null = null;     // dev aid: look at a point instead of the model's middle
  private focusNow: Vec3 = [0, 0, 0];
  private fallbackDistance: number;
  frame: CameraFrame;

  constructor(position: Vec3, target: Vec3, fovDeg: number) {
    this.target = [...target];
    this.fov = fovDeg * DEG;
    const ox = position[0] - target[0], oy = position[1] - target[1], oz = position[2] - target[2];
    this.fallbackDistance = Math.hypot(ox, oy, oz);
    this.baseYaw = Math.atan2(ox, oz);
    this.basePitch = Math.asin(Math.max(-1, Math.min(1, oy / this.fallbackDistance)));
    this.yaw = this.baseYaw;
    this.pitch = this.basePitch;
    this.fitRest = this.fitExploded = { distance: this.fallbackDistance, shift: [0, 0, 0] };
    this.frame = this.compute(0, 0);
  }

  get aspect() { return this.aspectRatio; }
  set aspect(value: number) {
    if (Math.abs(value - this.aspectRatio) < 1e-4) return;
    this.aspectRatio = value;
    this.refit();
  }

  // The corners the view must keep in frame: the closed model's bounds and the exploded ones.
  setBounds(rest: Vec3[], exploded: Vec3[]) {
    this.restBounds = rest;
    this.explodedBounds = exploded;
    this.refit();
  }
  setExplode(t: number) { this.explode = t; }
  // Dev aid: ease the look-at point to `p` (world), or back to the fitted centre with null.
  focus(p: Vec3 | null) { this.focusWant = p; }

  private refit() {
    if (!this.restBounds.length) return;
    this.fitRest = this.fit(this.restBounds);
    this.fitExploded = this.fit(this.explodedBounds.length ? this.explodedBounds : this.restBounds);
  }

  // Distance (along the default view direction) at which `corners` fill `this.fill` of the
  // limiting dimension, and the look-at shift that centres them. Perspective, so a few rounds
  // of re-centring.
  private fit(corners: Vec3[]): Fit {
    const cp = Math.cos(this.basePitch);
    const f: Vec3 = [-cp * Math.sin(this.baseYaw), -Math.sin(this.basePitch), -cp * Math.cos(this.baseYaw)];
    let r: Vec3 = [-f[2], 0, f[0]];
    const rl = Math.hypot(r[0], r[2]) || 1;
    r = [r[0] / rl, 0, r[2] / rl];
    const u: Vec3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const th = Math.tan(this.fov / 2), tw = th * this.aspectRatio;
    const rel = corners.map(c => [c[0] - this.target[0], c[1] - this.target[1], c[2] - this.target[2]] as Vec3);
    const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let sa = 0, sc = 0, d = this.fallbackDistance;
    for (let round = 0; round < 5; round++) {
      d = 0.05;
      for (const p of rel) {
        const a = dot(p, r) - sa, c = dot(p, u) - sc, b = dot(p, f);
        d = Math.max(d, Math.abs(a) / (this.fill * tw) - b, Math.abs(c) / (this.fill * th) - b, 0.06 - b);
      }
      // Centre what is projected: the extremes of the corners on screen at this distance.
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of rel) {
        const z = dot(p, f) + d;
        const x = (dot(p, r) - sa) / (z * tw), y = (dot(p, u) - sc) / (z * th);
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      sa += ((x0 + x1) / 2) * tw * d;
      sc += ((y0 + y1) / 2) * th * d;
    }
    return { distance: d, shift: [r[0] * sa + u[0] * sc, r[1] * sa + u[1] * sc, r[2] * sa + u[2] * sc] };
  }

  // Pointer interaction. Deltas are in CSS pixels.
  dragStart(time: number) { this.dragging = true; this.resetting = false; this.yawVel = 0; this.pitchVel = 0; this.lastTouch = time; }
  drag(dx: number, dy: number, dt: number, time: number) {
    this.lastTouch = time;
    const k = 0.0055;
    this.yaw -= dx * k;
    this.pitch = clampPitch(this.pitch + dy * k);
    if (dt > 0) {
      // Smoothed angular velocity for the release.
      const a = Math.min(1, dt * 18);
      this.yawVel += (-dx * k / dt - this.yawVel) * a;
      this.pitchVel += (dy * k / dt - this.pitchVel) * a;
    }
  }
  dragEnd(time: number) { this.dragging = false; this.lastTouch = time; }
  zoom(factor: number, time: number) {
    this.resetting = false;
    this.lastTouch = time;
    this.zoomFactor = Math.min(2.4, Math.max(0.25, this.zoomFactor * factor));
  }
  nudge(dyaw: number, dpitch: number, time: number) {
    this.resetting = false;
    this.lastTouch = time;
    this.yaw += dyaw;
    this.pitch = clampPitch(this.pitch + dpitch);
  }
  reset(time: number) {
    this.resetting = true;
    this.lastTouch = time;
    this.yawVel = this.pitchVel = 0;
    // The shortest way round to the default yaw.
    this.yaw = this.baseYaw + wrapPi(this.yaw - this.baseYaw);
  }
  touch(time: number) { this.lastTouch = time; }
  get busy() { return this.dragging; }
  // The pointer is over the machine: the idle sway coasts to a stop and holds its angle, and
  // starts again a few seconds after the pointer leaves.
  setHover(on: boolean) { this.hovering = on; }

  update(dt: number, time: number) {
    if (this.resetting) {
      const a = 1 - Math.exp(-dt * 5);
      this.yaw += (this.baseYaw - this.yaw) * a;
      this.pitch += (this.basePitch - this.pitch) * a;
      this.zoomFactor += (1 - this.zoomFactor) * a;
      if (Math.abs(this.yaw - this.baseYaw) < 1e-3 && Math.abs(this.pitch - this.basePitch) < 1e-3 && Math.abs(this.zoomFactor - 1) < 1e-3) { this.zoomFactor = 1; this.resetting = false; }
    } else if (!this.dragging) {
      this.yaw += this.yawVel * dt;
      this.pitch = clampPitch(this.pitch + this.pitchVel * dt);
      const decay = Math.exp(-dt * 3.2);
      this.yawVel *= decay;
      this.pitchVel *= decay;
    }
    // Idle sway: after four quiet seconds it fades in. A touch (drag, wheel, keys) fades it out at once.
    // The pointer resting over the machine only stops it, easing to a halt and holding the angle; it
    // starts again three seconds after the pointer leaves.
    if (this.hovering) this.hoverEnd = time;
    const touchRecent = this.dragging || this.resetting || time - this.lastTouch <= 4 || Math.abs(this.yawVel) >= 0.02;
    const holding = this.hovering || time - this.hoverEnd < 3;
    const idle = !this.reduced && !touchRecent && !holding;
    if (touchRecent) this.sway += (0 - this.sway) * (1 - Math.exp(-dt * 6));
    else if (idle) this.sway += (1 - this.sway) * (1 - Math.exp(-dt * 0.8));
    this.swayRate += ((idle ? 1 : 0) - this.swayRate) * (1 - Math.exp(-dt / (idle ? 1.0 : 0.6)));
    this.swayPhase += dt * this.swayRate;
    const sy = Math.sin(this.swayPhase * 0.42) * 7 * DEG * this.sway;
    const sp = Math.sin(this.swayPhase * 0.31 + 1.3) * 1.6 * DEG * this.sway;
    this.frame = this.compute(sy, sp);
  }

  private compute(swayYaw: number, swayPitch: number): CameraFrame {
    const yaw = this.yaw + swayYaw;
    const pitch = clampPitch(this.pitch + swayPitch);
    const e = this.explode;
    const a = this.fitRest, b = this.fitExploded;
    const fx = this.focusWant;
    const base: Vec3 = [
      this.target[0] + a.shift[0] + (b.shift[0] - a.shift[0]) * e,
      this.target[1] + a.shift[1] + (b.shift[1] - a.shift[1]) * e,
      this.target[2] + a.shift[2] + (b.shift[2] - a.shift[2]) * e,
    ];
    for (let k = 0; k < 3; k++) this.focusNow[k] += (((fx ? fx[k] - base[k] : 0)) - this.focusNow[k]) * 0.12;
    const d = (a.distance + (b.distance - a.distance) * e) * this.zoomFactor;
    const cp = Math.cos(pitch);
    const t: Vec3 = [base[0] + this.focusNow[0], base[1] + this.focusNow[1], base[2] + this.focusNow[2]];
    const eye: Vec3 = [
      t[0] + d * cp * Math.sin(yaw),
      t[1] + d * Math.sin(pitch),
      t[2] + d * cp * Math.cos(yaw),
    ];
    const { view, right, up, forward } = lookAt(eye, t, [0, 1, 0]);
    const proj = perspective(this.fov, this.aspect, 0.02, 40);
    return { eye, target: t, right, up, forward, viewProj: multiply(proj, view), distance: d, tanHalfFov: Math.tan(this.fov / 2), aspect: this.aspect };
  }

  // World ray through a point of the canvas (CSS pixels from its top-left).
  ray(x: number, y: number, width: number, height: number): { origin: Vec3; dir: Vec3 } {
    const f = this.frame;
    const nx = (x / width) * 2 - 1;
    const ny = 1 - (y / height) * 2;
    const sx = nx * f.tanHalfFov * f.aspect, sy = ny * f.tanHalfFov;
    const dx = f.forward[0] + f.right[0] * sx + f.up[0] * sy;
    const dy = f.forward[1] + f.right[1] * sx + f.up[1] * sy;
    const dz = f.forward[2] + f.right[2] * sx + f.up[2] * sy;
    const l = Math.hypot(dx, dy, dz);
    return { origin: f.eye, dir: [dx / l, dy / l, dz / l] };
  }

  // World point -> CSS pixels; `visible` is false when it is behind the camera.
  project(p: Vec3, width: number, height: number): { x: number; y: number; visible: boolean } {
    const m = this.frame.viewProj;
    const cx = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const cy = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (cw <= 0.01) return { x: 0, y: 0, visible: false };
    return { x: (cx / cw * 0.5 + 0.5) * width, y: (0.5 - cy / cw * 0.5) * height, visible: true };
  }
}

function clampPitch(p: number) {
  return Math.min(PITCH_MAX, Math.max(PITCH_MIN, p));
}

// Slab test of a ray against an axis-aligned box. Returns the entry distance, or -1 for a miss.
export function rayBox(o: Vec3, d: Vec3, min: Vec3, max: Vec3): number {
  let t0 = 0, t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < min[a] || o[a] > max[a]) return -1;
    } else {
      let ta = (min[a] - o[a]) / d[a], tb = (max[a] - o[a]) / d[a];
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) return -1;
    }
  }
  return t0;
}
