// Sanity-check client/public/wtr-max/{model.json,points.bin} against the contract in
// client/src/viz/machine/types.ts.  Plain Node, no dependencies:
//   node model/wtr-max/check.mjs [dir]        (default: client/public/wtr-max)
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'client/public/wtr-max');
const STRIDE = 12;
const FLAG = { Exterior: 1, Edge: 2, Interior: 4 };
const PART_KINDS = new Set(['shell', 'hdd', 'sled', 'nvme', 'backplane', 'board', 'cpu', 'ram', 'fan', 'psu', 'port', 'io', 'led', 'screen']);
const KEYS = new Set(['shell', 'bay1', 'bay2', 'bay3', 'bay4', 'bay5', 'bay6', 'm2sled', 'm2s1', 'm2s2', 'm2s3', 'm2s4', 'm2s5',
  'backplane', 'board', 'cpu', 'ram1', 'ram2', 'fan1', 'fan2', 'fan3', 'fan4', 'psu', 'lan1', 'lan2', 'sfp1', 'sfp2', 'io', 'led', 'lcd']);

let failures = 0;
const fail = (msg) => { failures++; console.error('FAIL  ' + msg); };
const ok = (cond, msg) => { if (!cond) fail(msg); };
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x));

const man = JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8'));
const buf = readFileSync(join(dir, 'points.bin'));
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

// ---- manifest shape ----
ok(man.version === 1, 'version is 1');
ok(typeof man.name === 'string' && man.name.length > 0, 'name');
ok(man.units === 'm', 'units are metres');
ok(man.stride === STRIDE, `stride is ${STRIDE}`);
ok(isVec3(man.bounds?.min) && isVec3(man.bounds?.max), 'bounds are vec3');
ok(man.bounds.min.every((v, i) => v < man.bounds.max[i]), 'bounds min < max');
ok(Number.isInteger(man.pointCount) && man.pointCount > 0, 'pointCount');
ok(buf.length === man.pointCount * STRIDE, `points.bin is ${buf.length} bytes, expected ${man.pointCount * STRIDE}`);
ok(Array.isArray(man.parts) && man.parts.length > 0 && man.parts.length <= 255, 'parts');
ok(isVec3(man.camera?.position) && isVec3(man.camera?.target) && man.camera.fovDeg > 10 && man.camera.fovDeg < 90, 'camera');
ok(man.anchors && typeof man.anchors === 'object', 'anchors');
for (const need of ['sata', 'cpu', 'bus', 'nicbus']) ok(isVec3(man.anchors?.[need]), `anchor "${need}"`);
for (const [k, v] of Object.entries(man.anchors ?? {})) ok(isVec3(v), `anchor ${k} is a vec3`);

// ---- parts: ids, keys, contiguous sorted ranges, counts add up ----
const seen = new Set();
let expectStart = 0;
man.parts.forEach((p, i) => {
  ok(p.id === i, `part ${p.key}: id ${p.id} != index ${i}`);
  ok(KEYS.has(p.key), `part key "${p.key}" is not in the contract list`);
  ok(!seen.has(p.key), `duplicate key ${p.key}`);
  seen.add(p.key);
  ok(PART_KINDS.has(p.kind), `part ${p.key}: unknown kind ${p.kind}`);
  ok(typeof p.label === 'string' && p.label, `part ${p.key}: label`);
  ok(p.start === expectStart, `part ${p.key}: start ${p.start} != running total ${expectStart}`);
  ok(Number.isInteger(p.count) && p.count > 0, `part ${p.key}: count ${p.count}`);
  expectStart += p.count;
  for (const f of ['center', 'size', 'socket', 'explode']) ok(isVec3(p[f]), `part ${p.key}: ${f} is a vec3`);
  if (p.slide !== undefined) ok(isVec3(p.slide), `part ${p.key}: slide`);
  if (p.key.startsWith('m2s') && p.key !== 'm2sled') ok(p.location === 'sled' || p.location === 'board', `part ${p.key}: location`);
  else ok(p.location === undefined, `part ${p.key}: location only for M.2 slots`);
  if (/^bay\d$/.test(p.key) || p.key === 'm2sled') ok(p.slide && p.slide[2] > 0, `part ${p.key}: slide along +z`);
});
ok(expectStart === man.pointCount, `ranges sum to ${expectStart}, pointCount is ${man.pointCount}`);
for (const k of ['shell', 'bay1', 'bay2', 'bay3', 'bay4', 'bay5', 'bay6', 'm2sled', 'm2s1', 'm2s2', 'm2s3', 'm2s4', 'm2s5', 'backplane', 'board', 'cpu', 'ram1', 'ram2', 'fan1', 'fan2', 'lan1', 'lan2', 'sfp1', 'sfp2', 'io', 'lcd'])
  ok(seen.has(k), `expected part ${k}`);

// ---- decode and check every point ----
const lo = man.bounds.min, hi = man.bounds.max;
const stats = man.parts.map(() => ({ n: 0, ext: 0, int: 0, edge: 0, both: 0, none: 0, tmin: 255, tmax: 0, tsum: 0, nmin: 9, nmax: 0,
  mn: [1e9, 1e9, 1e9], mx: [-1e9, -1e9, -1e9] }));
const q = (v, i) => lo[i] + (v / 65535) * (hi[i] - lo[i]);
let badPart = 0, badNormal = 0, badFlags = 0, outside = 0, unsorted = 0, prevPart = -1;
for (let i = 0; i < man.pointCount; i++) {
  const o = i * STRIDE;
  const x = q(dv.getUint16(o, true), 0), y = q(dv.getUint16(o + 2, true), 1), z = q(dv.getUint16(o + 4, true), 2);
  const nx = dv.getInt8(o + 6) / 127, ny = dv.getInt8(o + 7) / 127, nz = dv.getInt8(o + 8) / 127;
  const part = dv.getUint8(o + 9), tone = dv.getUint8(o + 10), fl = dv.getUint8(o + 11);
  if (part >= man.parts.length) { badPart++; continue; }
  const P = man.parts[part];
  if (i < P.start || i >= P.start + P.count) badPart++;
  if (part < prevPart) unsorted++;
  prevPart = part;
  const len = Math.hypot(nx, ny, nz);
  if (len < 0.95 || len > 1.05) badNormal++;
  const hasE = !!(fl & FLAG.Exterior), hasI = !!(fl & FLAG.Interior);
  if (hasE === hasI || (fl & ~7)) badFlags++;
  const s = stats[part];
  s.n++;
  if (hasE) s.ext++; if (hasI) s.int++; if (fl & FLAG.Edge) s.edge++;
  s.tmin = Math.min(s.tmin, tone); s.tmax = Math.max(s.tmax, tone); s.tsum += tone;
  s.nmin = Math.min(s.nmin, len); s.nmax = Math.max(s.nmax, len);
  const p3 = [x, y, z];
  for (let a = 0; a < 3; a++) {
    s.mn[a] = Math.min(s.mn[a], p3[a]); s.mx[a] = Math.max(s.mx[a], p3[a]);
    if (p3[a] < lo[a] - 1e-9 || p3[a] > hi[a] + 1e-9) outside++;
  }
}
ok(badPart === 0, `${badPart} points have a part id outside the part's range`);
ok(unsorted === 0, `${unsorted} points break the part ordering`);
ok(badNormal === 0, `${badNormal} normals are not near unit length`);
ok(badFlags === 0, `${badFlags} points do not carry exactly one of Exterior/Interior`);
ok(outside === 0, `${outside} coordinates outside bounds`);

// each part's points sit inside its own AABB (centre +- size/2) within quantisation error
const quant = Math.max(...hi.map((h, i) => (h - lo[i]) / 65535)) * 1.5 + 1e-5;
man.parts.forEach((p, i) => {
  const s = stats[i];
  ok(s.n === p.count, `part ${p.key}: decoded ${s.n} points, manifest says ${p.count}`);
  for (let a = 0; a < 3; a++) {
    const a0 = p.center[a] - p.size[a] / 2 - quant, a1 = p.center[a] + p.size[a] / 2 + quant;
    ok(s.mn[a] >= a0 && s.mx[a] <= a1, `part ${p.key}: points leave the part box on axis ${'xyz'[a]} (${s.mn[a].toFixed(4)}..${s.mx[a].toFixed(4)} vs ${a0.toFixed(4)}..${a1.toFixed(4)})`);
  }
  ok(p.socket.every((v, a) => v >= p.center[a] - p.size[a] / 2 - 0.02 && v <= p.center[a] + p.size[a] / 2 + 0.02), `part ${p.key}: socket is far from the part`);
});

// ---- front LCD: exact regular dot grid ----
const scr = man.screen;
let lcdInfo = 'no manifest.screen';
ok(scr && typeof scr === 'object', 'manifest.screen is present');
if (scr) {
  const lcd = man.parts.find((p) => p.key === scr.part);
  ok(!!lcd, `screen.part "${scr.part}" is a part`);
  ok(isVec3(scr.origin) && isVec3(scr.u) && isVec3(scr.v), 'screen origin/u/v are vec3');
  ok(Number.isInteger(scr.cols) && Number.isInteger(scr.rows) && scr.cols > 0 && scr.rows > 0, 'screen cols/rows are integers');
  if (lcd && isVec3(scr.origin) && isVec3(scr.u) && isVec3(scr.v)) {
    ok(lcd.kind === 'screen', 'lcd kind is screen');
    ok(lcd.count === scr.cols * scr.rows, `lcd has ${lcd.count} points, cols x rows is ${scr.cols * scr.rows}`);
    ok(lcd.slide === undefined, 'lcd has no slide');
    const shell = man.parts.find((p) => p.key === 'shell');
    ok(shell && lcd.explode.every((v, a) => v === shell.explode[a]), 'lcd explodes with the shell');
    // u runs left to right, v top to bottom, both in the front plane (front faces +z)
    ok(scr.u[0] > 0 && Math.abs(scr.u[1]) < 1e-9 && Math.abs(scr.u[2]) < 1e-9, 'u runs to the right');
    ok(scr.v[1] < 0 && Math.abs(scr.v[0]) < 1e-9 && Math.abs(scr.v[2]) < 1e-9, 'v runs down');
    const pu = Math.hypot(...scr.u) / scr.cols, pv = Math.hypot(...scr.v) / scr.rows;
    ok(Math.abs(pu / pv - 1) < 1e-4, `dot pitch is not square: ${(pu * 1000).toFixed(4)} x ${(pv * 1000).toFixed(4)} mm`);
    ok(lcd.socket.every((v, a) => Math.abs(v - (scr.origin[a] + 0.5 * scr.u[a] + 0.5 * scr.v[a])) < 1e-4), 'lcd socket is not the centre of the glass');
    const tol = hi.map((h, a) => (h - lo[a]) / 65535 * 0.51 + 3e-7);   // one half quantisation step per axis
    const seenDot = new Uint8Array(scr.cols * scr.rows);
    let off = 0, maxErr = 0, rowMajor = 0, notExt = 0, badN = 0, badTone = 0, dup = 0;
    for (let k = 0; k < lcd.count; k++) {
      const o = (lcd.start + k) * STRIDE;
      const P3 = [q(dv.getUint16(o, true), 0), q(dv.getUint16(o + 2, true), 1), q(dv.getUint16(o + 4, true), 2)];
      // which dot is this?  invert origin + (c + .5)/cols u + (r + .5)/rows v
      const c = Math.round(((P3[0] - scr.origin[0]) / scr.u[0]) * scr.cols - 0.5), r = Math.round(((P3[1] - scr.origin[1]) / scr.v[1]) * scr.rows - 0.5);
      if (c < 0 || c >= scr.cols || r < 0 || r >= scr.rows) { off++; continue; }
      const ex = scr.origin.map((v, a) => v + (c + 0.5) / scr.cols * scr.u[a] + (r + 0.5) / scr.rows * scr.v[a]);
      const err = ex.map((v, a) => Math.abs(v - P3[a]) / tol[a]);
      maxErr = Math.max(maxErr, ...err);
      if (err.some((e) => e > 1)) off++;
      if (seenDot[r * scr.cols + c]++) dup++;
      if (c === k % scr.cols && r === Math.floor(k / scr.cols)) rowMajor++;
      const nx = dv.getInt8(o + 6) / 127, ny = dv.getInt8(o + 7) / 127, nz = dv.getInt8(o + 8) / 127;
      if (Math.abs(nx) > 0.02 || Math.abs(ny) > 0.02 || nz < 0.98) badN++;
      if (dv.getUint8(o + 11) !== FLAG.Exterior) notExt++;
      const tn = dv.getUint8(o + 10) / 255;
      if (Math.abs(tn - 0.9) > 0.02) badTone++;
    }
    ok(off === 0, `${off} lcd points are not on the grid`);
    ok(dup === 0 && seenDot.every((v) => v === 1), `grid coverage: ${dup} duplicates, ${seenDot.filter((v) => v !== 1).length} empty dots`);
    ok(rowMajor === lcd.count, `${lcd.count - rowMajor} lcd points are not in row-major order (point k = dot c = k % cols, r = floor(k / cols))`);
    ok(notExt === 0, `${notExt} lcd points are not flagged Exterior only`);
    ok(badN === 0, `${badN} lcd normals are not +z`);
    ok(badTone === 0, `${badTone} lcd tones are not ~0.9`);
    lcdInfo = `${scr.cols} x ${scr.rows} = ${lcd.count} dots, pitch ${(pu * 1000).toFixed(4)} x ${(pv * 1000).toFixed(4)} mm, active ${(Math.hypot(...scr.u) * 1000).toFixed(1)} x ${(Math.hypot(...scr.v) * 1000).toFixed(2)} mm, max grid error ${maxErr.toFixed(2)} of a half quantisation step`;
  }
}

// ---- table ----
const f = (v, d = 3) => v.toFixed(d);
const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${dir}\n${man.name}: ${man.pointCount} points, ${(buf.length / 1e6).toFixed(2)} MB points.bin\n`);
console.log(pad('id', 3), pad('key', 9), pad('kind', 9), pad('points', 7), pad('ext', 6), pad('int', 6), pad('edge%', 6), pad('tone', 5), pad('center (m)', 25), pad('size (mm)', 18), 'slide z');
man.parts.forEach((p, i) => {
  const s = stats[i];
  console.log(pad(p.id, 3), pad(p.key, 9), pad(p.kind, 9), pad(p.count, 7), pad(s.ext, 6), pad(s.int, 6), pad((100 * s.edge / s.n).toFixed(0), 6),
    pad((s.tsum / s.n / 255).toFixed(2), 5), pad(p.center.map((v) => f(v)).join(' '), 25), pad(p.size.map((v) => (v * 1000).toFixed(0)).join(' x '), 18), p.slide ? f(p.slide[2]) : '-');
});
const tot = stats.reduce((a, s) => ({ n: a.n + s.n, e: a.e + s.edge, x: a.x + s.ext }), { n: 0, e: 0, x: 0 });
console.log(`\ntotal ${tot.n}  edge ${(100 * tot.e / tot.n).toFixed(1)}%  exterior ${(100 * tot.x / tot.n).toFixed(1)}%`);
console.log('bounds', man.bounds.min.map((v) => f(v)).join(' '), '->', man.bounds.max.map((v) => f(v)).join(' '));
console.log('camera', JSON.stringify(man.camera));
console.log('lcd   ', lcdInfo);
console.log('anchors', Object.entries(man.anchors).map(([k, v]) => `${k}=[${v.map((x) => f(x)).join(',')}]`).join('  '));

// spread of the flow anchors (the engine draws particle streams through them)
const d = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const A = man.anchors;
console.log(`anchor spacing (cm): sata-bus ${(d(A.sata, A.bus) * 100).toFixed(1)}, bus-cpu ${(d(A.bus, A.cpu) * 100).toFixed(1)}, sata-cpu ${(d(A.sata, A.cpu) * 100).toFixed(1)}, nicbus-cpu ${(d(A.nicbus, A.cpu) * 100).toFixed(1)}`);
const bays = man.parts.filter((p) => /^bay\d$/.test(p.key));
let minBay = 1e9;
for (let i = 0; i < bays.length; i++) for (let j = i + 1; j < bays.length; j++) minBay = Math.min(minBay, d(bays[i].socket, bays[j].socket));
console.log(`closest pair of drive sockets: ${(minBay * 100).toFixed(1)} cm`);
for (const k of ['sata', 'bus', 'cpu', 'nicbus']) for (const k2 of ['sata', 'bus', 'cpu', 'nicbus']) if (k < k2) ok(d(A[k], A[k2]) > 0.03, `anchors ${k} and ${k2} are less than 3 cm apart`);

// exploded view: no two parts' boxes should overlap once offsets are applied (composites such as io are boxes with holes)
const box = (p) => p.center.map((c, a) => [c + p.explode[a] - p.size[a] / 2, c + p.explode[a] + p.size[a] / 2]);
const overl = [];
for (let i = 0; i < man.parts.length; i++) for (let j = i + 1; j < man.parts.length; j++) {
  const a = box(man.parts[i]), b = box(man.parts[j]);
  const pair = [man.parts[i].key, man.parts[j].key].sort().join('/');
  if (pair === 'lcd/shell') continue;      // the screen sits in the bezel and explodes with it, on purpose
  if ([0, 1, 2].every((k) => Math.min(a[k][1], b[k][1]) - Math.max(a[k][0], b[k][0]) > 0.001)) overl.push(pair);
}
console.log(`exploded-box overlaps: ${overl.length ? overl.join(', ') : 'none'}`);
ok(overl.length === 0, `exploded view overlaps: ${overl.join(', ')}`);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
