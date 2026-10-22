// WGSL for the Machine scene: a compute pass that moves every point on a damped spring toward
// its target, instanced billboard draws for the body and the flow particles, and the bloom and
// tonemap chain. Layouts are explicit (see engine.ts) so Safari and Chromium agree.
import { WGSL_COMMON } from '../../lib/gpu';

// Shared by the compute and draw modules. Everything is vec4-aligned so the CPU side can pack
// plain Float32Arrays.
const SHARED = /* wgsl */ `
struct U {
  vp: mat4x4f,
  eye: vec4f,      // xyz camera position, w time (s)
  right: vec4f,    // xyz camera right, w dt (s)
  up: vec4f,       // xyz camera up, w point count
  light: vec4f,    // xyz direction towards the key light, w open (0 closed .. 1 opened up)
  view: vec4f,     // viewport w, h (device px), dpr, point size scale
  fx: vec4f,       // x xray, y reduced motion, z intro start (s), w intro length (s)
  seed: vec4f,     // xyz where the intro starts from
  ray0: vec4f,     // xyz pointer ray origin, w pointer active 0..1
  ray1: vec4f,     // xyz pointer ray direction, w depth the pointer works at
  misc: vec4f,     // x repel radius, y repel strength, z breathing amplitude (m), w jitter amplitude (m)
  ext: vec4f,      // x flow count, y camera distance, z flow particle count, w how far the case is exploded
  fwd: vec4f,      // xyz camera forward
  focus: vec4f,    // xyz what the camera looks at, w how far apart points are on screen (1 = as designed)
  scr0: vec4f,     // front screen: xyz origin (top-left), w columns
  scr1: vec4f,     // xyz u (to the top-right), w rows
  scr2: vec4f,     // xyz v (to the bottom-left), w 1 when the screen is live
  shellMin: vec4f, // xyz the closed case's bounding box, w 1 when there is one
  shellMax: vec4f,
};

// One per part. Static points carry (x, y, z, part + 256 * flags) and (nx, ny, nz, tone).
struct Part {
  color: vec4f,    // rgb linear, a intensity
  anim: vec4f,     // activity, pulse, highlight, kind (0 body, 1 shell, 2 live screen)
  slide: vec4f,    // xyz pull-out vector, w how far (0..1)
  explode: vec4f,  // xyz exploded offset, w how far (0..1)
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> pts: array<vec4f>;
@group(0) @binding(2) var<storage, read> parts: array<Part>;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn hash1(v: u32) -> f32 { return f32(pcg(v)) * (1.0 / 4294967296.0); }
`;

export const SIM_SHADER = /* wgsl */ `
${SHARED}
@group(0) @binding(3) var<storage, read_write> state: array<vec4f>;

// The part's move, staggered per point so it flows like a flock instead of sliding like a box.
fn stag(t: f32, d: f32) -> f32 {
  let x = clamp((t - d * 0.5) / 0.5, 0.0, 1.0);
  return x * x * (3.0 - 2.0 * x);
}

// A cheap divergence-free-looking wobble.
fn curl(p: vec3f, t: f32) -> vec3f {
  return vec3f(
    sin(p.y * 61.0 + t * 0.9) + 0.5 * sin(p.z * 113.0 - t * 1.3 + 1.7),
    sin(p.z * 57.0 + t * 0.8 + 2.1) + 0.5 * sin(p.x * 127.0 + t * 1.1),
    sin(p.x * 67.0 - t * 1.0 + 4.2) + 0.5 * sin(p.y * 109.0 + t * 1.2 + 0.6));
}

@compute @workgroup_size(64)
fn sim_init(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(u.up.w)) { return; }
  let a = pts[i * 2u];
  let r = vec3f(hash1(i * 3u + 1u), hash1(i * 3u + 2u), hash1(i * 3u + 3u)) - 0.5;
  var p = u.seed.xyz + r * 0.006;
  var arrived = 0.0;
  if (u.fx.y > 0.5) { p = a.xyz; arrived = 1.0; }
  state[i * 2u] = vec4f(p, arrived);
  state[i * 2u + 1u] = vec4f(0.0);
}

@compute @workgroup_size(64)
fn sim_step(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(u.up.w)) { return; }
  let a = pts[i * 2u];
  let part = parts[u32(a.w) & 255u];
  let rest = a.xyz;
  let t = u.eye.w;
  let dt = u.right.w;
  let h1 = hash1(i);
  let h2 = hash1(i ^ 0x68bc21ebu);
  let h3 = hash1(i * 3u + 0x2545f491u);

  var st = state[i * 2u];
  var vl = state[i * 2u + 1u];

  // Where the part wants this point: slide and explode, each staggered by a mix of a random
  // delay and a travelling wave, and some turbulence while it is in transit.
  let wave = 0.5 + 0.5 * sin(dot(rest, vec3f(23.0, 17.0, 29.0)) + h2 * 1.2);
  let d = 0.5 * h1 + 0.5 * wave;
  let ss = stag(part.slide.w, d);
  let se = stag(part.explode.w, d);
  var goal = rest + part.slide.xyz * ss + part.explode.xyz * se;
  let transit = max(sin(3.14159 * ss), sin(3.14159 * se));
  goal += curl(rest * 0.4, t * 2.0) * (0.012 * transit);

  // Breathing (about a millimetre) and the jitter of a busy part. The screen holds still so
  // its text stays crisp.
  let is_screen = part.anim.w > 1.5;
  if (!is_screen) { goal += curl(rest, t) * u.misc.z; }
  if (!is_screen && part.anim.x > 0.001 && u.misc.w > 0.0) {
    let jt = u32(t * 20.0 + h1 * 7.0);
    let j = vec3f(hash1(i * 7u + jt * 131u), hash1(i * 11u + jt * 137u + 5u), hash1(i * 13u + jt * 149u + 9u)) - 0.5;
    goal += j * (2.0 * u.misc.w * part.anim.x);
  }

  // Intro: every point waits a random moment at the seed, then streams to its place along a swirl.
  let travel = 1.3;
  let delay = h1 * max(u.fx.w - travel, 0.0);
  let ti = clamp((t - u.fx.z - delay) / travel, 0.0, 1.0);
  if (ti < 1.0) {
    let e = ti * ti * (3.0 - 2.0 * ti);
    let rel = goal - u.seed.xyz;
    let swirl = normalize(vec3f(-rel.z, 0.35 * (h3 - 0.5), rel.x) + vec3f(1e-5));
    goal = u.seed.xyz + rel * e + swirl * (sin(3.14159 * ti) * 0.07 * (0.2 + h3));
  }

  // Damped spring toward the target, plus the pointer pushing points aside.
  let k = mix(70.0, 150.0, h3);
  let c = 2.0 * sqrt(k) * 0.72;
  var acc = (goal - st.xyz) * k - vl.xyz * c;
  if (u.ray0.w > 0.0 && !is_screen) {
    let rel = st.xyz - u.ray0.xyz;
    let s = dot(rel, u.ray1.xyz);
    let perp = rel - u.ray1.xyz * s;
    let dist = length(perp);
    let f = 1.0 - smoothstep(0.0, u.misc.x, dist);
    let dq = (s - u.ray1.w) / 0.09;
    let depth = exp(-dq * dq);
    let away = perp / (dist + 0.002);
    let swirl = cross(u.ray1.xyz, away);
    acc += (away + 0.35 * swirl) * (u.misc.y * f * f * depth * u.ray0.w);
  }
  vl = vec4f(vl.xyz + acc * dt, 0.0);
  st = vec4f(st.xyz + vl.xyz * dt, ti);
  state[i * 2u] = st;
  state[i * 2u + 1u] = vl;
}
`;

export const SCENE_SHADER = /* wgsl */ `
${WGSL_COMMON}
${SHARED}
struct Flow {
  color: vec4f,    // rgb linear, a gain
  a: vec4f,        // first particle, count, lut start, active fraction
  b: vec4f,        // phase (0..1 along the path), lateral spread (m), trail (px), unused
};
@group(0) @binding(3) var<storage, read> state: array<vec4f>;
@group(0) @binding(4) var<storage, read> flows: array<Flow>;
@group(0) @binding(5) var<storage, read> lut: array<vec4f>;
@group(0) @binding(6) var screenTex: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) col: vec3f,
  @location(2) extra: vec2f,
};

fn culled() -> VOut {
  var o: VOut;
  o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
  o.uv = vec2f(0.0);
  o.col = vec3f(0.0);
  o.extra = vec2f(0.0);
  return o;
}

fn to_px(clip: vec4f) -> vec2f { return clip.xy / clip.w * 0.5 * u.view.xy; }

// Where on the front screen a point sits, as (s, t) in 0..1 across and down (outside that range
// off the panel), from the dot grid's basis.
fn screen_st(p0: vec3f) -> vec2f {
  let su = u.scr1.xyz;
  let sv = u.scr2.xyz;
  let p = p0 - u.scr0.xyz;
  let a = dot(su, su);
  let b = dot(su, sv);
  let c = dot(sv, sv);
  let pu = dot(p, su);
  let pv = dot(p, sv);
  let det = a * c - b * b;
  return vec2f((pu * c - pv * b) / det, (pv * a - pu * b) / det);
}

// Which dot of the front screen a point sits on, from its rest position (the points are the dots).
fn screen_dot(rest: vec3f) -> vec2i {
  let st = screen_st(rest);
  let cols = i32(u.scr0.w);
  let rows = i32(u.scr1.w);
  return clamp(vec2i(i32(floor(st.x * f32(cols))), i32(floor(st.y * f32(rows)))), vec2i(0), vec2i(cols - 1, rows - 1));
}

// 1 when the panel is between the eye and this point, i.e. the point is behind the screen (the
// panel is opaque: nothing inside the case may show through it). Fades out as the case explodes,
// when the screen has left its place.
fn behind_screen(wp: vec3f, dist: f32) -> f32 {
  if (u.scr2.w < 0.5) { return 0.0; }
  let weight = 1.0 - smoothstep(0.0, 0.15, u.ext.w);
  if (weight <= 0.0) { return 0.0; }
  let n = normalize(cross(u.scr2.xyz, u.scr1.xyz));     // out of the panel, towards the front
  let o = u.scr0.xyz;
  let ro = u.eye.xyz;
  let rd = (wp - ro) / dist;
  let denom = dot(rd, n);
  if (dot(ro - o, n) <= 0.0 || dot(wp - o, n) > -0.0015 || denom >= -1e-5) { return 0.0; }
  let t = dot(o - ro, n) / denom;
  if (t <= 0.0 || t >= dist) { return 0.0; }
  let st = screen_st(ro + rd * t);
  let inside = st.x > -0.012 && st.x < 1.012 && st.y > -0.03 && st.y < 1.03;
  return select(0.0, weight, inside);
}

@vertex fn vs_points(@builtin(vertex_index) vi: u32, @builtin(instance_index) i: u32) -> VOut {
  let a = pts[i * 2u];
  let b = pts[i * 2u + 1u];
  let st = state[i * 2u];
  let vl = state[i * 2u + 1u];
  let word = u32(a.w);
  let pid = word & 255u;
  let flags = word >> 8u;
  let part = parts[pid];
  let gain = part.color.a;
  if (gain <= 0.003) { return culled(); }

  let t = u.eye.w;
  let open = u.light.w;
  let h1 = hash1(i);
  let h2 = hash1(i ^ 0x68bc21ebu);
  let h3 = hash1(i * 3u + 0x2545f491u);
  let act = part.anim.x;
  let pulse = part.anim.y;
  let hl = part.anim.z;
  let kind = part.anim.w;
  let shell = select(0.0, 1.0, kind > 0.5 && kind < 1.5);
  let is_screen = kind > 1.5;
  let is_edge = (flags & 2u) != 0u;
  let is_int = (flags & 4u) != 0u;
  let ti = st.w;

  // Before its turn in the intro a point is invisible, except a few that glow at the seed.
  if (ti <= 0.0 && h1 > 0.004) { return culled(); }

  // What is visible: interior points appear as the case opens (or leak through when lit by
  // data), and the shell thins to sparse dust.
  var vis = 1.0;
  if (is_int) {
    // Only a selection, a hover or an alert shows an inner part through the closed case (activity stays
    // on the outside); inner creases are bright and would draw the part's wireframe, so they leak less.
    let leak = clamp(0.4 * hl + 0.55 * pulse, 0.0, 0.7) * (1.0 - shell) * select(1.0, 0.25, is_edge);
    vis = max(smoothstep(0.0, 0.55, open), leak);
  }
  if (shell > 0.5) {
    let o = smoothstep(0.0, 0.6, open);
    if (h2 > mix(1.0, select(0.07, 0.5, is_edge), o)) { return culled(); }
    vis = vis * mix(1.0, 0.5, o);
  }
  if (vis < 0.004) { return culled(); }

  let wp = st.xyz;
  let nrm = b.xyz;
  let to_eye = u.eye.xyz - wp;
  let dist = length(to_eye);
  let V = to_eye / dist;
  let ndv = dot(nrm, V);
  // Back faces fall away (this stands in for hidden-surface removal); opened up they ghost back in.
  var facing = smoothstep(-0.3, 0.15, ndv);
  facing = max(facing, 0.3 * open);
  // Creases carry averaged normals, so a crease on the far side can still pass the soft facing test above:
  // while the case is closed only creases that face you show (the left wall's vent edges drew a faint
  // zigzag through the front); opened up they ghost back in.
  if (is_edge) { facing = max(mix(smoothstep(-0.02, 0.25, ndv), smoothstep(-0.3, 0.15, ndv), open), 0.5 * open); }
  // The shell is convex, so a shell point is only seen if nothing of the case lies between it and the
  // eye: points on the far walls (their vents and slots face the camera too) would otherwise show
  // through the front while the case is closed.
  if (shell > 0.5 && u.shellMin.w > 0.5 && open < 0.5) {
    let ray = (wp - u.eye.xyz) / dist;
    let inv = 1.0 / select(ray, vec3f(1e-6), abs(ray) < vec3f(1e-6));
    let t0 = (u.shellMin.xyz - u.eye.xyz) * inv;
    let t1 = (u.shellMax.xyz - u.eye.xyz) * inv;
    let tn = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
    let behind = tn > 0.0 && tn < dist - 0.03;
    facing = facing * mix(select(1.0, 0.0, behind), 1.0, smoothstep(0.0, 0.5, open));
  }
  if (!is_screen) { facing = facing * (1.0 - behind_screen(wp, dist)); }
  if (facing < 0.004) { return culled(); }

  // The front screen: emissive dots coloured from the view's canvas, not lit by the key. Unlit
  // dots keep a dim cool backlight so the panel reads as a screen even when it shows black.
  if (is_screen) {
    let clip = u.vp * vec4f(wp, 1.0);
    if (clip.w < 0.02) { return culled(); }
    let cell_ij = screen_dot(a.xyz);
    let lit = srgb_to_linear(textureLoad(screenTex, cell_ij, 0).rgb);
    let view = clamp(ndv, 0.0, 1.0);
    // Glass: full emission facing you, falling off toward grazing angles with a faint cool sheen.
    let glass = 0.3 + 0.7 * smoothstep(0.0, 0.6, view);
    let ty = (f32(cell_ij.y) + 0.5) / u.scr1.w;
    let q = (fract(t * 0.16) * 1.5 - 0.25 - ty) * 7.0;
    let band = select(exp(-q * q), 0.0, u.fx.y > 0.5);          // a barely-there refresh shimmer
    var e = (vec3f(0.0045, 0.009, 0.018) * (1.0 + 0.6 * band) + lit * 2.0) * glass;
    e = e + vec3f(0.5, 0.72, 1.0) * (pow(1.0 - view, 4.0) * 0.025);
    let sg = mix(1.0, gain, 0.35) * (1.0 + 0.5 * hl);
    let pitch = sqrt(length(u.scr1.xyz) / u.scr0.w * length(u.scr2.xyz) / u.scr1.w);   // metres between dots
    let cell = pitch * u.view.y / (2.0 * dist * u.fwd.w);                              // ... in device px
    let sr = max(cell * 0.5, 0.8);
    let comp = min(1.0, (cell / (2.0 * sr)) * (cell / (2.0 * sr)));
    let sc = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
    var so: VOut;
    so.pos = vec4f(clip.xy + sc * sr * (2.0 / u.view.xy) * clip.w, clip.z, clip.w);
    so.uv = sc;
    so.col = e * (sg * vis * facing * comp * (1.0 + 2.2 * sin(3.14159 * ti)));
    so.extra = vec2f(1.0, 0.0);
    return so;
  }

  // Light: a key from the upper left of the view. Faces toward it glow, the far side falls
  // toward black, and a cool rim keeps every silhouette readable.
  let lam = max(dot(nrm, u.light.xyz), 0.0);
  let key = pow(lam, 1.15);
  let toward = dot(wp - u.focus.xyz, u.light.xyz);            // metres toward the light
  let falloff = clamp(0.8 + 4.2 * toward, 0.14, 1.45);
  let shade = 0.08 * mix(1.0, falloff, 0.4) + 1.55 * key * falloff;
  let rim = pow(clamp(1.0 - abs(ndv), 0.0, 1.0), 3.0);
  let tone = b.w;
  // Data lives in colour: saturated colours are lifted toward the body's brightness (a blue
  // tray is dark in linear light), and the case itself stays a step back as context.
  let pc = part.color.rgb;
  let lum = dot(pc, vec3f(0.2126, 0.7152, 0.0722));
  let top = max(pc.r, max(pc.g, pc.b));
  let sat = (top - min(pc.r, min(pc.g, pc.b))) / max(top, 1e-4);
  let lift = mix(1.0, clamp(0.46 / max(lum, 0.02), 1.0, 2.2), clamp(sat * 1.2, 0.0, 1.0) * 0.9) * mix(1.0, 0.55, shell * smoothstep(0.4, 1.0, gain));
  let rim_col = mix(vec3f(0.45, 0.72, 1.0), pc, 0.3);
  // Points pile up where a surface is seen at a grazing angle; thin them out so a lit surface
  // keeps about the same brightness on screen from any angle (the rim adds the edge back).
  let area = select(mix(1.0, clamp(abs(ndv) * 1.7, 0.22, 1.0), 0.85), 1.0, is_edge);
  var col = pc * (tone * shade * area * lift) + rim_col * (rim * select(0.55, 0.85, is_edge) * (0.35 + 0.65 * tone) * mix(1.0, 0.55, shell * smoothstep(0.4, 1.0, gain)));
  // Creases catch the light: lit edges glow, the ones on the shadow side only hold a line.
  if (is_edge) { col = col * (0.95 + 1.1 * key) * mix(1.0, 0.75, shell); }
  // A little variance per point, and rare brighter glints that slowly twinkle.
  let h5 = hash1(i * 5u + 77u);
  let hg = hash1(i * 7u + 13u);
  let glint = pow(hg, 22.0);
  let tw = select(0.6 + 0.4 * sin(t * (0.7 + 2.2 * h3) + hg * 60.0), 1.0, u.fx.y > 0.5);
  col = col * mix(0.5, 1.15, h5 * h5) * (1.0 + 3.0 * glint * tw);
  col = col + pc * lift * (0.16 * glint * tw * tone);

  // Data motion: sparkle scaled by activity, a slow breathing glow for alerts.
  let rate = (0.6 + 3.0 * h2) * (0.4 + 3.6 * act);
  let sp = pow(0.5 + 0.5 * sin(6.2832 * (t * rate + h1 * 17.0)), 10.0) * act;
  let breath = 0.5 + 0.5 * sin(t * 2.6 + f32(pid) * 0.7);
  let g = gain * (1.0 + 0.65 * hl) * (1.0 + 0.35 * act) * (1.0 + pulse * (0.15 + 1.0 * breath));
  col = col * g * (1.0 + 4.0 * sp) + vec3f(0.3) * (sp * g);

  let depth_fade = mix(1.0, 0.5, smoothstep(-0.08, 0.4, dist - u.ext.y));
  let intro = 1.0 + 2.2 * sin(3.14159 * ti);
  // Smaller canvas or further away: the same points crowd into fewer pixels, so each one gets
  // dimmer and a little smaller; zoomed in, they get a little bigger.
  let dens = clamp(u.focus.w * clamp(u.ext.y / dist, 0.6, 1.5), 0.05, 4.0);
  let grow = clamp(pow(dens, 0.45), 0.6, 1.6);
  col = col * (vis * facing * depth_fade * intro * select(1.0, dens * dens / (grow * grow), dens < 1.0));

  let clip = u.vp * vec4f(wp, 1.0);
  if (clip.w < 0.02) { return culled(); }

  // Billboard size in device pixels, a streak along the motion while a point is travelling.
  let size = (0.95 + 1.0 * h3) * u.view.w * clamp(u.ext.y / dist, 0.6, 1.5) * grow
    * (1.0 + 0.3 * select(0.0, 1.0, is_edge)) * (1.0 + 0.45 * sp) * (1.0 + 0.2 * hl) * (1.0 + 0.5 * glint * tw);
  let rad = size * 1.5;
  let clip2 = u.vp * vec4f(wp + vl.xyz * 0.025, 1.0);
  var mv = vec2f(0.0);
  if (clip2.w > 0.02) { mv = to_px(clip2) - to_px(clip); }
  let mlen = length(mv);
  let dir = select(vec2f(1.0, 0.0), mv / mlen, mlen > 0.5);
  let stretch = min(mlen * 0.8, 26.0);
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  let ax = rad + stretch;
  let off_px = dir * (corner.x * ax) + vec2f(-dir.y, dir.x) * (corner.y * rad);

  var o: VOut;
  o.pos = vec4f(clip.xy + off_px * (2.0 / u.view.xy) * clip.w, clip.z, clip.w);
  o.uv = corner;
  o.col = col * pow(rad / ax, 1.7);
  o.extra = vec2f(0.0);
  return o;
}

// The body and the flows draw into separate targets so the flows can be soft-limited per pixel
// before they are added to the picture and to the bloom.
struct FragOut { @location(0) body: vec4f, @location(1) flow: vec4f };

@fragment fn fs_points(i: VOut) -> FragOut {
  if (i.extra.x > 0.5) {
    // Screen dots: a touch squarer than body points, filling most of their cell so the grid reads.
    let q = abs(i.uv) / 0.82;
    let r4 = q.x * q.x * q.x * q.x + q.y * q.y * q.y * q.y;
    let sa = 1.0 - smoothstep(0.7, 1.1, r4);
    // The alpha channel carries how much of a pixel's light is the screen's, so the bloom can take less of it.
    let c = i.col * sa;
    return FragOut(vec4f(c, dot(c, vec3f(0.2126, 0.7152, 0.0722))), vec4f(0.0));
  }
  let r2 = dot(i.uv, i.uv);
  if (r2 >= 1.0) { discard; }
  // A soft disc with a slightly sharper core.
  let soft = exp(-r2 * 3.2);
  let core = 1.0 - smoothstep(0.06, 0.4, r2);
  let a = (0.62 * soft + 0.5 * core) * (1.0 - r2);
  return FragOut(vec4f(i.col * a, 0.0), vec4f(0.0));
}

@vertex fn vs_flow(@builtin(vertex_index) vi: u32, @builtin(instance_index) i: u32) -> VOut {
  let nf = u32(u.ext.x);
  var fi = 0u;
  var found = false;
  for (var f = 0u; f < nf; f = f + 1u) {
    let fl = flows[f];
    if (f32(i) >= fl.a.x && f32(i) < fl.a.x + fl.a.y) { fi = f; found = true; }
  }
  if (!found) { return culled(); }
  let fl = flows[fi];
  let k = f32(i) - fl.a.x;
  if ((k + 0.5) / fl.a.y > fl.a.w) { return culled(); }

  let t = u.eye.w;
  let h1 = hash1(i * 2654435761u + 11u);
  let h2 = hash1(i * 40503u + 7u);
  let h3 = hash1(i * 9973u + 3u);
  let h4 = hash1(i * 31337u + 5u);
  let s = fract(h1 + fl.b.x);
  let base = u32(fl.a.z);
  let x = s * 63.0;
  let i0 = min(u32(floor(x)), 62u);
  let p0 = lut[base + i0].xyz;
  let p1 = lut[base + i0 + 1u].xyz;
  var p = mix(p0, p1, x - f32(i0));
  let tang = normalize(p1 - p0 + vec3f(1e-6));
  var side = cross(tang, vec3f(0.0, 1.0, 0.0));
  if (length(side) < 0.05) { side = cross(tang, vec3f(1.0, 0.0, 0.0)); }
  side = normalize(side);
  let upv = cross(side, tang);
  let taper = pow(sin(3.14159 * s), 0.6);
  let wob = 0.35 * sin(s * 23.0 + t * 2.2 + h2 * 6.28);
  let lat = ((h2 - 0.5) + (h3 - 0.5)) * fl.b.y * taper;
  let lon = ((h3 - 0.5) + (h4 - 0.5)) * fl.b.y * taper;
  p = p + side * (lat + wob * fl.b.y * 0.4) + upv * lon;

  let clip = u.vp * vec4f(p, 1.0);
  if (clip.w < 0.02) { return culled(); }
  if (behind_screen(p, length(u.eye.xyz - p)) > 0.5) { return culled(); }
  let ahead = u.vp * vec4f(p + tang * 0.01, 1.0);
  var dir = vec2f(1.0, 0.0);
  if (ahead.w > 0.02) {
    let mv = to_px(ahead) - to_px(clip);
    if (length(mv) > 1e-3) { dir = normalize(mv); }
  }
  let dist = length(u.eye.xyz - p);
  let persp = clamp(u.ext.y / dist, 0.6, 1.5);
  let rad = (1.6 + 1.2 * h4) * u.view.w * persp;
  let trail = fl.b.z * u.view.w * persp * (0.5 + 0.8 * h2);
  let ends = smoothstep(0.0, 0.05, s) * (1.0 - smoothstep(0.93, 1.0, s));
  let flick = 0.75 + 0.25 * sin(t * 9.0 + h1 * 40.0);
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  // Along the motion from the tail (-trail) to just past the head (+rad).
  let along = mix(-trail, rad * 1.4, corner.x * 0.5 + 0.5);
  let across = corner.y * rad * 1.4;
  let off_px = dir * along + vec2f(-dir.y, dir.x) * across;

  var o: VOut;
  o.pos = vec4f(clip.xy + off_px * (2.0 / u.view.xy) * clip.w, clip.z, clip.w);
  o.uv = vec2f(along, across);
  o.col = fl.color.rgb * (fl.color.a * ends * flick);
  o.extra = vec2f(rad, trail);
  return o;
}

@fragment fn fs_flow(i: VOut) -> FragOut {
  let rad = i.extra.x;
  let trail = max(i.extra.y, 1.0);
  let head = exp(-dot(i.uv, i.uv) / (rad * rad * 0.55));
  let tail_t = clamp(-i.uv.x / trail, 0.0, 1.0);
  let tail = select(0.0, exp(-i.uv.y * i.uv.y / (rad * rad * 0.35)) * pow(1.0 - tail_t, 1.8) * 0.5, i.uv.x < 0.0);
  let a = max(head, tail);
  // A hot core so the head reads brighter than anything in the body.
  let core = exp(-dot(i.uv, i.uv) / (rad * rad * 0.12));
  return FragOut(vec4f(0.0), vec4f(i.col * (a + 0.9 * core), a));
}
`;

// ---------- post ----------
const POST_PARAMS = /* wgsl */ `
struct P {
  bloom: f32, exposure: f32, vignette: f32, grain: f32,
  time: f32, threshold: f32, knee: f32, upGain: f32,
  flowLimit: f32, flowBloom: f32, screenBloom: f32, pad1: f32,
};
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs_full(@builtin(vertex_index) vi: u32) -> VO {
  let c = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: VO;
  o.pos = vec4f(c * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(c.x, 1.0 - c.y);
  return o;
}
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
`;

export const POST_SHADER = /* wgsl */ `
${WGSL_COMMON}
${POST_PARAMS}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> p: P;

fn tap(uv: vec2f) -> vec3f { return textureSampleLevel(src, smp, uv, 0.0).rgb; }

// Dual filter, down.
@fragment fn fs_down(i: VO) -> @location(0) vec4f {
  let ts = 1.0 / vec2f(textureDimensions(src));
  var c = tap(i.uv) * 4.0;
  c = c + tap(i.uv + vec2f(-ts.x, -ts.y)) + tap(i.uv + vec2f(ts.x, -ts.y)) + tap(i.uv + vec2f(-ts.x, ts.y)) + tap(i.uv + vec2f(ts.x, ts.y));
  return vec4f(c / 8.0, 1.0);
}

// Dual filter, up. Blended additively onto the next level up.
@fragment fn fs_up(i: VO) -> @location(0) vec4f {
  let ts = 1.0 / vec2f(textureDimensions(src));
  var c = tap(i.uv + vec2f(-ts.x * 2.0, 0.0)) + tap(i.uv + vec2f(ts.x * 2.0, 0.0)) + tap(i.uv + vec2f(0.0, -ts.y * 2.0)) + tap(i.uv + vec2f(0.0, ts.y * 2.0));
  c = c + 2.0 * (tap(i.uv + vec2f(-ts.x, -ts.y)) + tap(i.uv + vec2f(ts.x, -ts.y)) + tap(i.uv + vec2f(-ts.x, ts.y)) + tap(i.uv + vec2f(ts.x, ts.y)));
  return vec4f(c / 12.0 * p.upGain, 1.0);
}
`;

// The flows are additive and pile up where streams share a trunk; this keeps their luminance
// under a ceiling (about the limit) while leaving a lone stream untouched, so a busy trunk gets
// thicker and brighter but never a white blob. Hue is preserved.
const FLOW_LIMIT = /* wgsl */ `
fn limit_flow(c: vec3f) -> vec3f {
  let r = luma(c) / p.flowLimit;
  return c / sqrt(1.0 + r * r);
}
`;

// Scene + limited flows -> first bloom level: Karis-weighted 4x4 box so single bright points
// can't fire-fly, then a soft threshold so only the lit parts bloom. Flows count for less here.
export const PREFILTER_SHADER = /* wgsl */ `
${POST_PARAMS}
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var flowTex: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var<uniform> p: P;
${FLOW_LIMIT}
fn both(uv: vec2f) -> vec3f {
  let sc = textureSampleLevel(scene, smp, uv, 0.0);
  // sc.a is the luminance that came from the front screen: its share of the pixel feeds the bloom at screenBloom.
  let share = clamp(sc.a / max(luma(sc.rgb), 1e-4), 0.0, 1.0);
  return sc.rgb * (1.0 - (1.0 - p.screenBloom) * share) + limit_flow(textureSampleLevel(flowTex, smp, uv, 0.0).rgb) * p.flowBloom;
}

@fragment fn fs_prefilter(i: VO) -> @location(0) vec4f {
  let ts = 1.0 / vec2f(textureDimensions(scene));
  var sum = vec3f(0.0);
  var wsum = 0.0;
  for (var k = 0u; k < 4u; k = k + 1u) {
    let o = vec2f(select(-1.0, 1.0, (k & 1u) != 0u), select(-1.0, 1.0, (k & 2u) != 0u));
    let s = both(i.uv + o * ts);
    let w = 1.0 / (1.0 + luma(s));
    sum = sum + s * w;
    wsum = wsum + w;
  }
  let c = sum / wsum;
  let br = max(c.r, max(c.g, c.b));
  let soft = clamp(br - p.threshold + p.knee, 0.0, 2.0 * p.knee);
  let contrib = max(soft * soft / (4.0 * p.knee + 1e-4), br - p.threshold) / max(br, 1e-4);
  return vec4f(c * contrib, 1.0);
}
`;

export const COMPOSITE_SHADER = /* wgsl */ `
${WGSL_COMMON}
${POST_PARAMS}
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var flowTex: texture_2d<f32>;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;
@group(0) @binding(3) var smp: sampler;
@group(0) @binding(4) var<uniform> p: P;
${FLOW_LIMIT}
fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// ACES on the luminance keeps the hue of saturated data colours; the per-channel curve mixed
// back in lets only the hottest cores go white.
fn tonemap(c: vec3f) -> vec3f {
  let l = max(dot(c, vec3f(0.2126, 0.7152, 0.0722)), 1e-5);
  var keep = c * (aces(vec3f(l)).x / l);
  keep = keep / max(1.0, max(keep.r, max(keep.g, keep.b)));
  return mix(keep, aces(c), 0.2 + 0.6 * smoothstep(1.5, 8.0, l));
}

@fragment fn fs(i: VO) -> @location(0) vec4f {
  let s = textureSampleLevel(scene, smp, i.uv, 0.0).rgb + limit_flow(textureSampleLevel(flowTex, smp, i.uv, 0.0).rgb);
  let b = textureSampleLevel(bloomTex, smp, i.uv, 0.0).rgb;
  var c = (s + b * p.bloom) * p.exposure;
  let q = i.uv - vec2f(0.5);
  c = c * (1.0 - p.vignette * dot(q, q) * 2.0);
  c = tonemap(c);
  var o = linear_to_srgb(c);
  // Film grain, only where there is light: pure black stays pure black.
  let px = vec2u(i.pos.xy);
  let n = f32(pcg(px.x + pcg(px.y + pcg(u32(p.time * 60.0))))) * (1.0 / 4294967296.0) - 0.5;
  let lum = dot(o, vec3f(0.3333));
  o = o + vec3f(n * p.grain * smoothstep(0.0, 0.04, lum));
  return vec4f(max(o, vec3f(0.0)), 1.0);
}
`;
