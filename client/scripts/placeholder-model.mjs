#!/usr/bin/env node
// Writes a rough stand-in for the WTR MAX point cloud to client/lab/placeholder/{model.json,points.bin},
// in the exact format of client/src/viz/machine/types.ts, so the Machine scene can be built and
// tuned before the real Blender model exists. Deterministic: the same run gives the same bytes.
//
//   node client/scripts/placeholder-model.mjs
//
// A ~30 x 22 x 25 cm six-bay NAS: case, six front trays with 3.5" drives, an M.2 sled, a
// backplane, board, CPU cooler, two SO-DIMMs, two fans and the rear ports. Metres, +y up, the
// drive trays face +z, origin at the middle of the footprint on the floor.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lab', 'placeholder');

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x70a57);

const EXT = 1, EDGE = 2, INT = 4;

// ---------- vector helpers ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const clamp01 = v => Math.max(0, Math.min(1, v));

// ---------- parts and sampling ----------
const parts = [];
let cur = null;
function part(key, kind, label, extra = {}) {
  cur = { key, kind, label, pts: [], ...extra };
  parts.push(cur);
  return cur;
}
function add(p, n, tone, flags) {
  const t = clamp01(tone * (0.9 + 0.2 * rand()));
  cur.pts.push([p[0], p[1], p[2], n[0], n[1], n[2], t, flags]);
}

// Stratified samples over the parallelogram o + s*u + t*v. f(sMetres, tMetres, point) returns a
// tone multiplier, or null to leave a hole.
function quad(o, u, v, n, density, tone, flags, f) {
  const lu = len(u), lv = len(v);
  const total = Math.max(1, Math.round(lu * lv * density));
  const nu = Math.max(1, Math.round(Math.sqrt(total * lu / lv)));
  const nv = Math.max(1, Math.round(total / nu));
  for (let a = 0; a < nu; a++) {
    for (let b = 0; b < nv; b++) {
      const s = (a + rand()) / nu, t = (b + rand()) / nv;
      const p = [o[0] + u[0] * s + v[0] * t, o[1] + u[1] * s + v[1] * t, o[2] + u[2] * s + v[2] * t];
      let tn = tone;
      if (f) {
        const m = f(s * lu, t * lv, p);
        if (m === null) continue;
        tn *= m;
      }
      add(p, n, tn, flags);
    }
  }
}

function line(a, b, n, spacing, tone, flags) {
  const l = len(sub(b, a));
  const count = Math.max(1, Math.round(l / spacing));
  for (let k = 0; k < count; k++) {
    const t = (k + rand()) / count;
    add([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], n, tone, flags);
  }
}

// An axis-aligned box. opts: skip ['-y', ...], toneFor { '+x': 0.8 }, inward (normals point in),
// edges (spacing in metres, or 0 for none), fn (per-face hole/tone function by face key).
function box(min, max, density, tone, flags, opts = {}) {
  const d = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const sign = opts.inward ? -1 : 1;
  const faces = [
    ['+x', [1, 0, 0], [max[0], min[1], min[2]], [0, d[1], 0], [0, 0, d[2]]],
    ['-x', [-1, 0, 0], [min[0], min[1], min[2]], [0, d[1], 0], [0, 0, d[2]]],
    ['+y', [0, 1, 0], [min[0], max[1], min[2]], [d[0], 0, 0], [0, 0, d[2]]],
    ['-y', [0, -1, 0], [min[0], min[1], min[2]], [d[0], 0, 0], [0, 0, d[2]]],
    ['+z', [0, 0, 1], [min[0], min[1], max[2]], [d[0], 0, 0], [0, d[1], 0]],
    ['-z', [0, 0, -1], [min[0], min[1], min[2]], [d[0], 0, 0], [0, d[1], 0]],
  ];
  const skip = new Set(opts.skip ?? []);
  for (const [k, n, o, u, v] of faces) {
    if (skip.has(k)) continue;
    const nn = [n[0] * sign, n[1] * sign, n[2] * sign];
    const dens = opts.densityFor?.[k] ?? density;
    quad(o, u, v, nn, dens, opts.toneFor?.[k] ?? tone, flags, opts.fn?.[k]);
  }
  if (opts.edges) {
    for (let axis = 0; axis < 3; axis++) {
      const b = (axis + 1) % 3, c = (axis + 2) % 3;
      for (const vb of [0, 1]) {
        for (const vc of [0, 1]) {
          const kb = (vb ? '+' : '-') + 'xyz'[b], kc = (vc ? '+' : '-') + 'xyz'[c];
          if (skip.has(kb) && skip.has(kc)) continue;
          const a0 = [0, 0, 0], a1 = [0, 0, 0], nrm = [0, 0, 0];
          a0[axis] = min[axis]; a1[axis] = max[axis];
          a0[b] = a1[b] = vb ? max[b] : min[b];
          a0[c] = a1[c] = vc ? max[c] : min[c];
          nrm[b] = (vb ? 1 : -1) * sign; nrm[c] = (vc ? 1 : -1) * sign;
          line(a0, a1, norm(nrm), opts.edges, Math.min(1, tone * 1.6 + 0.2), flags | EDGE);
        }
      }
    }
  }
}

function discXY(cx, cy, z, r0, r1, nz, density, tone, flags, f) {
  // Annulus in the xy plane, normal +-z.
  const area = Math.PI * (r1 * r1 - r0 * r0);
  const total = Math.round(area * density);
  for (let k = 0; k < total; k++) {
    const r = Math.sqrt(r0 * r0 + rand() * (r1 * r1 - r0 * r0));
    const a = rand() * Math.PI * 2;
    const p = [cx + Math.cos(a) * r, cy + Math.sin(a) * r, z];
    let tn = tone;
    if (f) { const m = f(r, a, p); if (m === null) continue; tn *= m; }
    add(p, [0, 0, nz], tn, flags);
  }
}

// ---------- the machine ----------
const W = 0.30, H = 0.22, D = 0.25;
const hx = W / 2, hz = D / 2;
const pitch = 0.0415, slotW = 0.0375;
const bayX = i => (i - 2.5) * pitch;
const SLOT_Y0 = 0.052, SLOT_Y1 = 0.198;
const SLED = { x0: -0.1, x1: 0.1, y0: 0.0135, y1: 0.0445 };
const RJ = { y: 0.034 };
const rearPorts = [
  { key: 'lan1', kind: 'port', label: '2.5GbE LAN 1', x: -0.118, w: 0.0165, h: 0.014, depth: 0.022 },
  { key: 'lan2', kind: 'port', label: '2.5GbE LAN 2', x: -0.095, w: 0.0165, h: 0.014, depth: 0.022 },
  { key: 'sfp1', kind: 'port', label: '10GbE SFP+ 1', x: -0.071, w: 0.0135, h: 0.0095, depth: 0.03 },
  { key: 'sfp2', kind: 'port', label: '10GbE SFP+ 2', x: -0.053, w: 0.0135, h: 0.0095, depth: 0.03 },
];
const ioPorts = [
  { x: -0.026, w: 0.0145, h: 0.0072 }, { x: -0.006, w: 0.0145, h: 0.0072 },
  { x: 0.014, w: 0.009, h: 0.0036 }, { x: 0.030, w: 0.009, h: 0.0036 },
  { x: 0.050, w: 0.0155, h: 0.0058 }, { x: 0.072, w: 0.0125, h: 0.0062 },
  { x: 0.100, w: 0.0125, h: 0.0125 },
];
const fans = [{ key: 'fan1', x: -0.062, y: 0.135 }, { key: 'fan2', x: 0.062, y: 0.135 }];
const FAN_R = 0.045, FAN_Z = -hz + 0.012;

// Holes in the back panel: the ports and the fan grilles.
const backHoles = [
  ...rearPorts.map(p => ({ x0: p.x - p.w / 2 - 0.002, x1: p.x + p.w / 2 + 0.002, y0: RJ.y - p.h / 2 - 0.002, y1: RJ.y + p.h / 2 + 0.002 })),
  ...ioPorts.map(p => ({ x0: p.x - p.w / 2 - 0.002, x1: p.x + p.w / 2 + 0.002, y0: RJ.y - p.h / 2 - 0.002, y1: RJ.y + p.h / 2 + 0.002 })),
];
const inBackHole = (x, y) =>
  backHoles.some(h => x > h.x0 && x < h.x1 && y > h.y0 && y < h.y1) ||
  fans.some(f => Math.hypot(x - f.x, y - f.y) < FAN_R);

const slotRects = Array.from({ length: 6 }, (_, i) => ({ x0: bayX(i) - slotW / 2 - 0.0012, x1: bayX(i) + slotW / 2 + 0.0012, y0: SLOT_Y0, y1: SLOT_Y1 }));
const inFrontHole = (x, y) =>
  slotRects.some(r => x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1) ||
  (x > SLED.x0 - 0.002 && x < SLED.x1 + 0.002 && y > SLED.y0 - 0.001 && y < SLED.y1 + 0.001);

// --- shell ---
part('shell', 'shell', 'Case', {
  explode: [0, 0.0, 0],
  socket: [0, 0.11, 0],
});
{
  const o = (x, y, z) => [x, y, z];
  const seam = (m, edge) => (edge < 0.004 ? m * 0.55 : m);
  // Outer faces. Denser where the default camera looks.
  quad(o(-hx, 0, hz), [W, 0, 0], [0, H, 0], [0, 0, 1], 320000, 0.7, EXT, (s, t, p) => {
    const x = p[0], y = p[1];
    if (inFrontHole(x, y)) return null;
    const near = Math.min(...slotRects.map(r => Math.max(r.x0 - x, x - r.x1, r.y0 - y, y - r.y1, 0)), 1);
    return seam(1, Math.min(s, W - s, t, H - t)) * (near < 0.0025 ? 1.2 : 1);
  });
  quad(o(-hx, H, -hz), [W, 0, 0], [0, 0, D], [0, 1, 0], 190000, 0.72, EXT, (s, t, p) => {
    // Vent grille on the rear half of the lid.
    const x = p[0], z = p[2];
    if (Math.abs(x) < 0.1 && z > -0.112 && z < -0.03 && ((z + 0.112) % 0.0075) < 0.0036) return null;
    return seam(1, Math.min(s, W - s, t, D - t));
  });
  quad(o(hx, 0, -hz), [0, 0, D], [0, H, 0], [1, 0, 0], 220000, 0.68, EXT, (s, t, p) => (Math.abs(p[1] - 0.11) < 0.0016 ? 0.4 : seam(1, Math.min(s, D - s, t, H - t))));
  quad(o(-hx, 0, -hz), [0, 0, D], [0, H, 0], [-1, 0, 0], 30000, 0.68, EXT, (s, t, p) => (Math.abs(p[1] - 0.11) < 0.0016 ? 0.4 : seam(1, Math.min(s, D - s, t, H - t))));
  quad(o(-hx, 0, -hz), [W, 0, 0], [0, H, 0], [0, 0, -1], 40000, 0.66, EXT, (s, t, p) => (inBackHole(p[0], p[1]) ? null : seam(1, Math.min(s, W - s, t, H - t))));
  quad(o(-hx, 0, -hz), [W, 0, 0], [0, 0, D], [0, -1, 0], 20000, 0.5, EXT);
  // Inner skin: what you see through the thinned shell.
  const dens = 12000, tone = 0.32;
  quad(o(-hx + 0.002, 0.002, hz - 0.003), [W - 0.004, 0, 0], [0, H - 0.004, 0], [0, 0, -1], dens, tone, INT, (s, t, p) => (inFrontHole(p[0], p[1]) ? null : 1));
  quad(o(-hx + 0.002, H - 0.002, -hz), [W - 0.004, 0, 0], [0, 0, D - 0.003], [0, -1, 0], dens, tone, INT);
  quad(o(hx - 0.002, 0.002, -hz), [0, 0, D - 0.003], [0, H - 0.004, 0], [-1, 0, 0], dens, tone, INT);
  quad(o(-hx + 0.002, 0.002, -hz), [0, 0, D - 0.003], [0, H - 0.004, 0], [1, 0, 0], dens, tone, INT);
  quad(o(-hx + 0.002, 0.002, -hz + 0.002), [W - 0.004, 0, 0], [0, H - 0.004, 0], [0, 0, 1], dens, tone, INT, (s, t, p) => (inBackHole(p[0], p[1]) ? null : 1));
  quad(o(-hx + 0.002, 0.002, -hz), [W - 0.004, 0, 0], [0, 0, D - 0.003], [0, 1, 0], dens * 0.5, tone, INT);
  // Silhouette edges.
  box([-hx, 0, -hz], [hx, H, hz], 1, 0.7, EXT | EDGE, { skip: ['+x', '-x', '+y', '-y', '+z', '-z'], edges: 0.0011 });
  // Outline the six tray openings and the sled opening.
  for (const r of [...slotRects, { x0: SLED.x0 - 0.002, x1: SLED.x1 + 0.002, y0: SLED.y0 - 0.001, y1: SLED.y1 + 0.001 }]) {
    const z = hz;
    for (const [a, b] of [[[r.x0, r.y0, z], [r.x1, r.y0, z]], [[r.x0, r.y1, z], [r.x1, r.y1, z]], [[r.x0, r.y0, z], [r.x0, r.y1, z]], [[r.x1, r.y0, z], [r.x1, r.y1, z]]]) {
      line(a, b, [0, 0, 1], 0.0012, 0.85, EXT | EDGE);
    }
  }
}

// --- six 3.5" bays ---
for (let i = 0; i < 6; i++) {
  const xc = bayX(i);
  part(`bay${i + 1}`, 'hdd', `Bay ${i + 1}`, {
    socket: [xc, 0.116, -0.0235],
    slide: [0, 0, 0.17],
    explode: [xc * 0.55, 0, 0.13],
  });
  const zf = hz + 0.003;
  // Front plate with handle recess, latch and LED.
  quad([xc - 0.0185, 0.054, zf], [0.037, 0, 0], [0, 0.142, 0], [0, 0, 1], 380000, 0.86, EXT, (s, t) => {
    let m = 1;
    if (t > 0.012 && t < 0.045 && Math.abs(s - 0.0185) < 0.0075) m *= 0.4;          // handle recess
    if (Math.abs(t - 0.092) < 0.0009) m *= 0.4;                                      // latch seam
    if (Math.hypot(s - 0.0285, t - 0.127) < 0.0026) m *= 1.4;                        // status LED
    if (t > 0.139 || t < 0.003) m *= 1.25;                                            // lip
    return m;
  });
  for (const [a, b] of [[[xc - 0.0185, 0.054, zf], [xc + 0.0185, 0.054, zf]], [[xc - 0.0185, 0.196, zf], [xc + 0.0185, 0.196, zf]], [[xc - 0.0185, 0.054, zf], [xc - 0.0185, 0.196, zf]], [[xc + 0.0185, 0.054, zf], [xc + 0.0185, 0.196, zf]]]) {
    line(a, b, [0, 0, 1], 0.0012, 0.95, EXT | EDGE);
  }
  // Carrier and the drive itself, seen when the tray is out or the case is open.
  box([xc - 0.0185, 0.054, zf - 0.025], [xc + 0.0185, 0.196, zf - 0.003], 50000, 0.4, INT, { skip: ['+z'], densityFor: { '-z': 20000 } });
  box([xc - 0.013, 0.065, -0.0225], [xc + 0.013, 0.167, 0.115], 90000, 0.5, INT, {
    edges: 0.0018,
    toneFor: { '+x': 0.72, '-x': 0.62, '+z': 0.45 },
    fn: {
      '+x': (s, t) => {
        // Label with a few text lines.
        if (s > 0.02 && s < 0.12 && t > 0.015 && t < 0.085) return ((t * 1000) % 7 < 3.2) ? 1.5 : 0.95;
        return 1;
      },
    },
  });
  // SATA connector block on the back of the drive.
  box([xc - 0.0105, 0.104, -0.0295], [xc + 0.0105, 0.124, -0.0225], 260000, 0.9, INT, { edges: 0.0012 });
}

// --- M.2 sled and sticks ---
part('m2sled', 'sled', 'M.2 sled', { socket: [0, 0.03, 0.02], slide: [0, 0, 0.12], explode: [0, -0.06, 0.12] });
{
  const zf = hz + 0.002;
  quad([SLED.x0, SLED.y0 + 0.0005, zf], [SLED.x1 - SLED.x0, 0, 0], [0, SLED.y1 - SLED.y0 - 0.001, 0], [0, 0, 1], 320000, 0.84, EXT, (s, t) => (t > 0.011 && t < 0.0165 && Math.abs(s - 0.1) < 0.025 ? 0.4 : 1));
  line([SLED.x0, SLED.y0, zf], [SLED.x1, SLED.y0, zf], [0, 0, 1], 0.0012, 0.95, EXT | EDGE);
  line([SLED.x0, SLED.y1, zf], [SLED.x1, SLED.y1, zf], [0, 0, 1], 0.0012, 0.95, EXT | EDGE);
  box([SLED.x0 + 0.004, 0.0215, 0.0], [SLED.x1 - 0.004, 0.0235, zf - 0.002], 70000, 0.5, INT, { edges: 0.002 });
  box([SLED.x0 + 0.004, 0.0235, 0.0], [SLED.x0 + 0.006, 0.037, zf - 0.002], 60000, 0.42, INT);
  box([SLED.x1 - 0.006, 0.0235, 0.0], [SLED.x1 - 0.004, 0.037, zf - 0.002], 60000, 0.42, INT);
}
function m2stick(key, label, x0, z0, z1, y, location, slide) {
  part(key, 'nvme', label, { location, socket: [x0 + 0.011, y + 0.0015, z0], ...(slide ? { slide } : {}), explode: location === 'sled' ? [x0 * 0.6, -0.04, 0.14] : [0.03, 0.09, 0] });
  box([x0, y, z0], [x0 + 0.022, y + 0.0032, z1], 520000, 0.6, INT, { edges: 0.0014, toneFor: { '+y': 0.8 } });
  // controller and NAND packages
  for (const [zc, w] of [[z0 + 0.012, 0.007], [z0 + 0.03, 0.011], [z0 + 0.052, 0.011], [z0 + 0.068, 0.004]]) {
    box([x0 + 0.0055, y + 0.0032, zc - w / 2], [x0 + 0.0165, y + 0.0044, zc + w / 2], 700000, 0.95, INT, { skip: ['-y'], edges: 0.0012 });
  }
}
m2stick('m2s1', 'M.2 slot 1', -0.062, 0.035, 0.115, 0.0247, 'sled', [0, 0, 0.12]);
m2stick('m2s2', 'M.2 slot 2', 0.04, 0.035, 0.115, 0.0247, 'sled', [0, 0, 0.12]);
m2stick('m2s3', 'M.2 slot 3', 0.096, -0.112, -0.032, 0.0185, 'board');

// --- backplane ---
part('backplane', 'backplane', 'SATA backplane', { socket: [0, 0.09, -0.036], explode: [0, 0.0, -0.07] });
{
  quad([-0.13, 0.05, -0.033], [0.26, 0, 0], [0, 0.15, 0], [0, 0, 1], 80000, 0.62, INT, (s, t) => (((s * 1000) % 5 < 0.9 && t > 0.01) || ((t * 1000) % 6 < 0.8 && s > 0.01) ? 1.4 : 1));
  quad([-0.13, 0.05, -0.0345], [0.26, 0, 0], [0, 0.15, 0], [0, 0, -1], 30000, 0.4, INT);
  line([-0.13, 0.05, -0.033], [0.13, 0.05, -0.033], [0, 0, 1], 0.0014, 0.9, INT | EDGE);
  line([-0.13, 0.2, -0.033], [0.13, 0.2, -0.033], [0, 0, 1], 0.0014, 0.9, INT | EDGE);
  for (let i = 0; i < 6; i++) box([bayX(i) - 0.0105, 0.1, -0.033], [bayX(i) + 0.0105, 0.12, -0.0295], 300000, 0.8, INT, { edges: 0.0012 });
  // controller
  box([-0.02, 0.07, -0.0365], [0.02, 0.1, -0.0335], 400000, 0.8, INT, { edges: 0.0012 });
}

// --- board ---
part('board', 'board', 'Motherboard', { socket: [-0.02, 0.016, -0.08], explode: [0, -0.07, 0] });
{
  quad([-0.135, 0.014, -0.118], [0.27, 0, 0], [0, 0, 0.218], [0, 1, 0], 100000, 0.5, INT, (s, t) => {
    const trace = ((s * 1000 + t * 400) % 9 < 0.9) || ((t * 1000 - s * 300) % 13 < 0.8);
    return trace ? 1.6 : 1;
  });
  quad([-0.135, 0.0125, -0.118], [0.27, 0, 0], [0, 0, 0.218], [0, -1, 0], 20000, 0.3, INT);
  box([-0.135, 0.0125, -0.118], [0.135, 0.014, 0.1], 1, 0.5, INT | EDGE, { skip: ['+x', '-x', '+y', '-y', '+z', '-z'], edges: 0.0014 });
  // components: caps, chips, connectors
  for (let k = 0; k < 70; k++) {
    const w = 0.003 + rand() * 0.008, d = 0.003 + rand() * 0.008, h = 0.002 + rand() * 0.006;
    const x = -0.125 + rand() * 0.25, z = -0.108 + rand() * 0.2;
    if (Math.abs(x + 0.032) < 0.035 && z < -0.03 && z > -0.105) continue;           // under the cooler
    if (x > 0.015 && x < 0.092 && z < -0.02 && z > -0.08) continue;                  // under the RAM
    box([x, 0.014, z], [x + w, 0.014 + h, z + d], 350000, 0.6 + rand() * 0.3, INT, { skip: ['-y'], edges: 0.0013 });
  }
  // Rear I/O shield strip and the board-to-backplane header.
  box([-0.125, 0.014, -0.116], [0.125, 0.026, -0.108], 400000, 0.6, INT, { skip: ['-y'], edges: 0.0014 });
}

// --- CPU and cooler ---
part('cpu', 'cpu', 'CPU and cooler', { socket: [-0.032, 0.034, -0.067], explode: [-0.04, 0.09, 0] });
{
  const x0 = -0.06, x1 = -0.005, z0 = -0.1, z1 = -0.035, y0 = 0.016, y1 = 0.05;
  // Heatsink fins running front to back: slots along x on top, ribs on the sides.
  quad([x0, y1, z0], [x1 - x0, 0, 0], [0, 0, z1 - z0], [0, 1, 0], 240000, 0.78, INT, (s) => ((s * 1000) % 3.6 < 1.2 ? 0.3 : 1));
  quad([x1, y0, z0], [0, 0, z1 - z0], [0, y1 - y0, 0], [1, 0, 0], 220000, 0.7, INT, (s, t) => ((t * 1000) % 3.6 < 1.2 ? 0.45 : 1));
  quad([x0, y0, z0], [0, 0, z1 - z0], [0, y1 - y0, 0], [-1, 0, 0], 200000, 0.55, INT, (s, t) => ((t * 1000) % 3.6 < 1.2 ? 0.45 : 1));
  quad([x0, y0, z1], [x1 - x0, 0, 0], [0, y1 - y0, 0], [0, 0, 1], 200000, 0.65, INT, (s) => ((s * 1000) % 3.6 < 1.2 ? 0.4 : 1));
  quad([x0, y0, z0], [x1 - x0, 0, 0], [0, y1 - y0, 0], [0, 0, -1], 120000, 0.5, INT);
  box([x0, y0, z0], [x1, y1, z1], 1, 0.8, INT | EDGE, { skip: ['+x', '-x', '+y', '-y', '+z', '-z'], edges: 0.0013 });
  // Heat pipes.
  for (const dz of [-0.012, 0.012]) box([x0 - 0.012, y0 + 0.002, (z0 + z1) / 2 + dz - 0.003], [x0, y0 + 0.008, (z0 + z1) / 2 + dz + 0.003], 450000, 0.85, INT, { edges: 0.0013 });
}

// --- RAM ---
for (const [key, label, z0] of [['ram1', 'DIMM 1', -0.045], ['ram2', 'DIMM 2', -0.075]]) {
  part(key, 'ram', label, { socket: [0.02, 0.023, z0 + 0.012], explode: [0.05, 0.1, z0 * 0.4] });
  box([0.02, 0.019, z0], [0.087, 0.0215, z0 + 0.0238], 330000, 0.55, INT, { edges: 0.0013, toneFor: { '+y': 0.75 } });
  for (let c = 0; c < 4; c++) box([0.028 + c * 0.0145, 0.0215, z0 + 0.004], [0.0395 + c * 0.0145, 0.0228, z0 + 0.02], 600000, 0.95, INT, { skip: ['-y'], edges: 0.0012 });
}

// --- fans ---
for (const f of fans) {
  part(f.key, 'fan', f.key === 'fan1' ? 'Fan 1' : 'Fan 2', { socket: [f.x, f.y, FAN_Z], explode: [f.x * 0.8, 0.02, -0.12] });
  const half = 0.0475;
  // square frame (both faces)
  for (const nz of [1, -1]) {
    const z = FAN_Z + nz * 0.009;
    quad([f.x - half, f.y - half, z], [2 * half, 0, 0], [0, 2 * half, 0], [0, 0, nz], 240000, 0.55, EXT | INT, (s, t, p) => (Math.hypot(p[0] - f.x, p[1] - f.y) < FAN_R - 0.001 ? null : 1));
    // hub
    discXY(f.x, f.y, FAN_Z + nz * 0.007, 0, 0.0155, nz, 500000, 0.9, INT);
    // seven curved blades
    for (let b = 0; b < 7; b++) {
      for (let k = 0; k < 260; k++) {
        const r = 0.0155 + rand() * (FAN_R - 0.017);
        const sweep = (r - 0.0155) * 9;
        const a = (b / 7) * Math.PI * 2 + sweep + (rand() - 0.5) * (0.5 * (0.7 + r * 22) / (r * 70));
        add([f.x + Math.cos(a) * r, f.y + Math.sin(a) * r, FAN_Z + nz * 0.004], [0.3 * Math.cos(a + 1.5), 0.3 * Math.sin(a + 1.5), nz * 0.9], 0.65, INT);
      }
    }
  }
  // grille rings and spokes on the rear face
  for (const rr of [0.011, 0.024, 0.037, FAN_R - 0.001]) {
    const n = Math.round(rr * 2 * Math.PI / 0.0016);
    for (let k = 0; k < n; k++) { const a = ((k + rand()) / n) * Math.PI * 2; add([f.x + Math.cos(a) * rr, f.y + Math.sin(a) * rr, -hz + 0.0008], [0, 0, -1], rr > 0.04 ? 0.95 : 0.8, EXT | EDGE); }
  }
  for (let sp = 0; sp < 4; sp++) {
    const a = (sp / 4) * Math.PI * 2 + Math.PI / 4;
    line([f.x + Math.cos(a) * 0.01, f.y + Math.sin(a) * 0.01, -hz + 0.0008], [f.x + Math.cos(a) * FAN_R, f.y + Math.sin(a) * FAN_R, -hz + 0.0008], [0, 0, -1], 0.0016, 0.75, EXT | EDGE);
  }
}

// --- rear ports ---
function portShape(x, w, h, depth) {
  const y = RJ.y, z = -hz;
  const x0 = x - w / 2, x1 = x + w / 2, y0 = y - h / 2, y1 = y + h / 2;
  // Bright frame around the mouth.
  quad([x0 - 0.0018, y0 - 0.0018, z - 0.0008], [w + 0.0036, 0, 0], [0, h + 0.0036, 0], [0, 0, -1], 900000, 0.9, EXT, (s, t) => (s > 0.0018 && s < w + 0.0018 && t > 0.0018 && t < h + 0.0018 ? null : 1));
  for (const [a, b] of [[[x0 - 0.0018, y0 - 0.0018, z - 0.0008], [x1 + 0.0018, y0 - 0.0018, z - 0.0008]], [[x0 - 0.0018, y1 + 0.0018, z - 0.0008], [x1 + 0.0018, y1 + 0.0018, z - 0.0008]], [[x0 - 0.0018, y0 - 0.0018, z - 0.0008], [x0 - 0.0018, y1 + 0.0018, z - 0.0008]], [[x1 + 0.0018, y0 - 0.0018, z - 0.0008], [x1 + 0.0018, y1 + 0.0018, z - 0.0008]]]) line(a, b, [0, 0, -1], 0.0009, 1, EXT | EDGE);
  // Cavity walls (normals inward) and back.
  box([x0, y0, z], [x1, y1, z + depth], 800000, 0.4, INT, { inward: true, skip: ['-z'] });
  // Contact tongue
  box([x0 + w * 0.15, y0 + h * 0.4, z + 0.002], [x1 - w * 0.15, y0 + h * 0.55, z + depth * 0.8], 900000, 0.95, INT, { skip: ['-y'] });
}
for (const p of rearPorts) {
  part(p.key, p.kind, p.label, { socket: [p.x, RJ.y, -hz], explode: [p.x * 0.25, 0, -0.1] });
  portShape(p.x, p.w, p.h, p.depth);
}
part('io', 'io', 'USB, video and power', { socket: [0.05, RJ.y, -hz], explode: [0.04, 0, -0.1] });
for (const p of ioPorts) portShape(p.x, p.w, p.h, 0.02);

// --- front LEDs ---
part('led', 'led', 'Status LEDs', { socket: [0.12, 0.209, hz], explode: [0, 0.04, 0.05] });
for (let k = 0; k < 3; k++) {
  const x = 0.1 + k * 0.014;
  for (let n = 0; n < 40; n++) {
    const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 0.0023;
    add([x + Math.cos(a) * r, 0.209 + Math.sin(a) * r, hz + 0.0006], [0, 0, 1], 1, EXT);
  }
}

// --- front LCD: a 128 x 24 dot matrix on the bezel above the trays, one point per dot ---
const LCD = { cols: 128, rows: 24, origin: [-0.12, 0.2165, hz + 0.0008], u: [0.096, 0, 0], v: [0, -0.0165, 0] };
part('lcd', 'screen', 'Front display', { socket: [-0.072, 0.208, hz], explode: [0, 0.04, 0.06] });
for (let r = 0; r < LCD.rows; r++) {
  for (let c = 0; c < LCD.cols; c++) {
    const s = (c + 0.5) / LCD.cols, t = (r + 0.5) / LCD.rows;
    cur.pts.push([LCD.origin[0] + LCD.u[0] * s + LCD.v[0] * t, LCD.origin[1] + LCD.u[1] * s + LCD.v[1] * t, LCD.origin[2], 0, 0, 1, 0.9, EXT]);
  }
}

// ---------- write ----------
let total = 0;
for (const p of parts) total += p.pts.length;
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (const p of parts) for (const q of p.pts) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], q[a]); max[a] = Math.max(max[a], q[a]); }
for (let a = 0; a < 3; a++) { min[a] -= 0.002; max[a] += 0.002; }

const bin = Buffer.alloc(total * 12);
const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
const infos = [];
let at = 0;
parts.forEach((p, id) => {
  const pmin = [Infinity, Infinity, Infinity], pmax = [-Infinity, -Infinity, -Infinity];
  for (const q of p.pts) {
    const o = at * 12;
    for (let a = 0; a < 3; a++) {
      dv.setUint16(o + a * 2, Math.round((q[a] - min[a]) / (max[a] - min[a]) * 65535), true);
      pmin[a] = Math.min(pmin[a], q[a]); pmax[a] = Math.max(pmax[a], q[a]);
      dv.setInt8(o + 6 + a, Math.round(q[3 + a] * 127));
    }
    dv.setUint8(o + 9, id);
    dv.setUint8(o + 10, Math.round(q[6] * 255));
    dv.setUint8(o + 11, q[7]);
    at++;
  }
  const r = v => Math.round(v * 1e5) / 1e5;
  const center = pmin.map((v, a) => r((v + pmax[a]) / 2));
  const info = {
    id, key: p.key, kind: p.kind, label: p.label,
    start: at - p.pts.length, count: p.pts.length,
    center, size: pmin.map((v, a) => r(pmax[a] - v)),
    socket: (p.socket ?? center).map(r),
    explode: (p.explode ?? [0, 0, 0]).map(r),
  };
  if (p.slide) info.slide = p.slide.map(r);
  if (p.location) info.location = p.location;
  infos.push(info);
});

const manifest = {
  version: 1,
  name: 'AOOSTAR WTR MAX (placeholder)',
  units: 'm',
  bounds: { min: min.map(v => Math.round(v * 1e5) / 1e5), max: max.map(v => Math.round(v * 1e5) / 1e5) },
  pointCount: total,
  stride: 12,
  parts: infos,
  anchors: {
    sata: [0, 0.085, -0.04],
    bus: [-0.02, 0.026, -0.082],
    cpu: [-0.032, 0.034, -0.067],
    nic: [-0.09, 0.03, -0.1],
  },
  camera: { position: [0.6, 0.46, 0.72], target: [0, 0.1, 0], fovDeg: 30 },
  screen: { part: 'lcd', origin: LCD.origin, u: LCD.u, v: LCD.v, cols: LCD.cols, rows: LCD.rows },
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'model.json'), JSON.stringify(manifest, null, 1));
writeFileSync(join(OUT, 'points.bin'), bin);
console.log(`placeholder model: ${total} points, ${parts.length} parts -> ${OUT}`);
for (const i of infos) console.log(`  ${String(i.id).padStart(2)} ${i.key.padEnd(9)} ${String(i.count).padStart(6)}`);
