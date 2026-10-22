// Contracts for the Machine view: a point-cloud twin of WTR (an AOOSTAR WTR MAX).
//
//   model/wtr-max/build.py (Blender)  ──▶  client/public/wtr-max/{model.json, points.bin}
//   model.ts loads them               ──▶  MachineScene (WebGPU) draws them
//   MachineView maps live state       ──▶  PartVisual / Flow / SceneLabel per part
//
// ---------- File format ----------
//
// model.json is a ModelManifest. points.bin holds `pointCount` records of `stride` (12) bytes,
// little-endian, sorted by part so each part is the contiguous range [start, start + count):
//
//   offset 0  u16 x, u16 y, u16 z   position quantized into bounds: min + v / 65535 * (max - min)
//   offset 6  i8 nx, i8 ny, i8 nz   surface normal * 127
//   offset 9  u8 part               index into manifest.parts (equal to parts[i].id)
//   offset 10 u8 tone               0..255 albedo/occlusion: how bright this point is under even light
//   offset 11 u8 flags              PointFlag bits
//
// Coordinates are metres at real size. +y is up, the front of the case (the drive trays) faces +z,
// and the origin is the centre of the case's footprint on the floor.

export const POINT_STRIDE = 12;

export const PointFlag = {
  Exterior: 1, // on the outside of the closed case (what you see when nothing is exploded)
  Edge: 2,     // sampled along a sharp edge or silhouette crease, not a face
  Interior: 4, // hidden by the shell when the case is closed
} as const;

// Fixed part keys. A model may omit parts it doesn't have, never rename them.
//   shell                 the case: top, sides, base, rear panel, front bezel
//   bay1..bay6            3.5" trays, left to right seen from the front; each includes its drive
//   m2sled                the front tray that carries M.2 drives
//   m2s1..m2s5            M.2 slots (with or without a stick); `location` says sled or board
//   backplane             SATA backplane / ASM1166 the trays plug into
//   board                 motherboard
//   cpu                   CPU and its cooler
//   ram1, ram2            SO-DIMMs
//   fan1, fan2 ...        fans
//   psu                   power supply, if internal
//   lan1, lan2            2.5 GbE RJ45 (Intel I226-V)
//   sfp1, sfp2            10 GbE SFP+ (Intel X710)
//   io                    the remaining rear ports (USB, USB4, OCuLink, HDMI, power in)
//   led                   front status LEDs
//   lcd                   the front screen (lower left): a regular dot grid, see ModelManifest.screen
export type PartKind = 'shell' | 'hdd' | 'sled' | 'nvme' | 'backplane' | 'board' | 'cpu' | 'ram' | 'fan' | 'psu' | 'port' | 'io' | 'led' | 'screen';

export type Vec3 = [number, number, number];

export interface PartInfo {
  id: number;           // equals its index in parts
  key: string;          // see the list above
  kind: PartKind;
  label: string;        // "Bay 3", "M.2 slot 2", "10GbE SFP+ 1"
  start: number;        // first point
  count: number;        // number of points
  center: Vec3;         // centre of its axis-aligned bounding box (model space, at rest)
  size: Vec3;           // full extent of that box
  socket: Vec3;         // where data enters or leaves (the drive's SATA connector, the port mouth)
  slide?: Vec3;         // offset when the part is pulled out (trays, sled); absent if it doesn't move
  explode: Vec3;        // offset in the exploded view
  location?: 'sled' | 'board'; // M.2 slots only
}

export interface ModelManifest {
  version: 1;
  name: string;               // "AOOSTAR WTR MAX"
  units: 'm';
  bounds: { min: Vec3; max: Vec3 };
  pointCount: number;
  stride: typeof POINT_STRIDE;
  parts: PartInfo[];
  // Named points for flow paths beyond part sockets: "sata" (controller), "cpu", "bus" (a point
  // on the board between them) and anything else the model finds useful.
  anchors: Record<string, Vec3>;
  camera: { position: Vec3; target: Vec3; fovDeg: number }; // the default 3/4 product shot
  // The front LCD as a cols × rows dot matrix: the points of `part` lie on the grid, dot (c, r)
  // at origin + (c + 0.5) / cols * u + (r + 0.5) / rows * v. origin is the top-left corner seen
  // from the front, u runs to the top-right corner, v to the bottom-left.
  screen?: { part: string; origin: Vec3; u: Vec3; v: Vec3; cols: number; rows: number };
}

// Decoded and ready for the GPU.
export interface MachineModel {
  manifest: ModelManifest;
  parts: PartInfo[];
  byKey: Map<string, PartInfo>;
  // Per point: xyz position (metres), part id as float, then normal xyz and tone 0..1 —
  // two vec4s, 8 floats per point.
  points: Float32Array;
  flags: Uint8Array;
}

// ---------- What the view tells the scene ----------

export interface PartVisual {
  color: Vec3;          // sRGB 0..1; the lens decides what it means
  intensity: number;    // brightness multiplier: 1 normal, ~0.25 a ghost, 0 hidden
  activity: number;     // 0..1 live work: shimmer, twinkle and jitter on this part's points
  pulse: number;        // 0..1 alert: a slow breathing glow, only for health problems
  slide: number;        // 0..1 how far the part is pulled out along its `slide` vector
}

// A stream of particles from one part or anchor to another, through `via` anchors in order.
export interface Flow {
  id: string;           // stable, so particles keep their phase between updates
  from: string;         // part key (its socket) or anchor name
  via: string[];
  to: string;
  rate: number;         // 0..1 density and speed (the view maps bytes/s onto this, log scale)
  color: Vec3;
}

// A DOM label pinned to a part's socket or centre. The scene positions it every frame.
export interface SceneLabel {
  key: string;          // part key
  at?: 'socket' | 'center' | 'top';
  content: React.ReactNode;
  tone?: 'default' | 'warning' | 'critical';
}

export interface MachineSceneProps {
  model: MachineModel;
  visuals: Record<string, PartVisual>; // by part key; parts not listed render with defaultVisual
  defaultVisual: PartVisual;
  flows: Flow[];
  labels: SceneLabel[];
  exploded: boolean;
  xray: number;                        // 0..1: how much the shell thins out to show the interior
  selected: string | null;
  hovered: string | null;              // controlled, so a list outside the canvas can drive it too
  onHover(key: string | null): void;
  onSelect(key: string | null): void;
  resetToken?: number;                 // changing it eases the camera back to the default view
  // What the front LCD shows: a canvas of manifest.screen.cols × rows pixels that the view draws
  // into, one pixel per dot, and a counter it bumps after each redraw so the scene re-uploads it.
  screen?: { canvas: HTMLCanvasElement; version: number };
  className?: string;
  ariaLabel: string;
}
