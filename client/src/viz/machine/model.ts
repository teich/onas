// Loads the WTR point-cloud model: model.json (a ModelManifest) plus points.bin (12-byte records,
// see types.ts) decoded into the two Float32 vec4s per point the scene wants.
import { POINT_STRIDE, type MachineModel, type ModelManifest } from './types';

const cache = new Map<string, Promise<MachineModel>>();

export function loadMachineModel(baseUrl = '/wtr-max'): Promise<MachineModel> {
  const base = baseUrl.replace(/\/+$/, '');
  let model = cache.get(base);
  if (!model) {
    model = fetchModel(base);
    cache.set(base, model);
    // A failed load must not be cached: the model may land later.
    model.catch(() => { if (cache.get(base) === model) cache.delete(base); });
  }
  return model;
}

async function fetchModel(base: string): Promise<MachineModel> {
  const [manifestRes, binRes] = await Promise.all([fetch(`${base}/model.json`), fetch(`${base}/points.bin`)]);
  if (!manifestRes.ok) throw new Error(`Could not load ${base}/model.json (HTTP ${manifestRes.status}).`);
  if (!binRes.ok) throw new Error(`Could not load ${base}/points.bin (HTTP ${binRes.status}).`);

  let manifest: ModelManifest;
  try {
    manifest = await manifestRes.json() as ModelManifest;
  } catch {
    // A dev server answers unknown paths with index.html; say what actually happened.
    throw new Error(`${base}/model.json is not JSON. The model has probably not been built yet.`);
  }
  if (manifest.version !== 1) throw new Error(`Unsupported model version ${String(manifest.version)}.`);
  if (manifest.stride !== POINT_STRIDE) throw new Error(`Unsupported point stride ${manifest.stride}.`);

  const bin = await binRes.arrayBuffer();
  const count = manifest.pointCount;
  if (bin.byteLength !== count * POINT_STRIDE) {
    throw new Error(`${base}/points.bin is ${bin.byteLength} bytes; expected ${count * POINT_STRIDE} for ${count} points.`);
  }
  return decode(manifest, bin);
}

export function decode(manifest: ModelManifest, bin: ArrayBuffer): MachineModel {
  const count = manifest.pointCount;
  const u16 = new Uint16Array(bin);   // 6 per record: x y z + the first half of the normal
  const i8 = new Int8Array(bin);
  const u8 = new Uint8Array(bin);
  const { min, max } = manifest.bounds;
  const sx = (max[0] - min[0]) / 65535, sy = (max[1] - min[1]) / 65535, sz = (max[2] - min[2]) / 65535;

  const points = new Float32Array(count * 8);
  const flags = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const r = i * POINT_STRIDE;
    const o = i * 8;
    const w = i * 6;
    points[o] = min[0] + u16[w] * sx;
    points[o + 1] = min[1] + u16[w + 1] * sy;
    points[o + 2] = min[2] + u16[w + 2] * sz;
    points[o + 3] = u8[r + 9];
    let nx = i8[r + 6], ny = i8[r + 7], nz = i8[r + 8];
    const len = Math.hypot(nx, ny, nz) || 1;   // the i8 quantization leaves it slightly off unit length
    nx /= len; ny /= len; nz /= len;
    points[o + 4] = nx;
    points[o + 5] = ny;
    points[o + 6] = nz;
    points[o + 7] = u8[r + 10] / 255;
    flags[i] = u8[r + 11];
  }

  const byKey = new Map(manifest.parts.map(p => [p.key, p]));
  return { manifest, parts: manifest.parts, byKey, points, flags };
}
