// Colour roles. Validated with the dataviz validator against the dark surface #1a1a19:
// the three categorical slots pass all-pairs (worst CVD ΔE 9.4, normal-vision 20.9).
// Pools are the one categorical identity on the storage views; status colours only ever
// mean health, and always come with an icon and a label.
export const SERIES = ['#3987e5', '#d95926', '#199e70'] as const;

const POOL_SLOT: Record<string, number> = { bulk: 0, fast: 1 };

export function poolColor(pool: string): string {
  return SERIES[POOL_SLOT[pool] ?? 2];
}

export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

export type StatusLevel = keyof typeof STATUS;

// Sequential blue for magnitude on the dark surface: near zero recedes toward the surface,
// high values are light. Lightness rises monotonically along the ramp.
export const SEQUENTIAL = ['#1e2229', '#172b45', '#14365f', '#104281', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#86b6ef', '#cde2fb'];

// Temperature ramp for the Machine view's Heat lens: cool blue, a pale midpoint, then amber,
// orange and red as a part nears its own limit. Stops are interpolated in OKLab so the steps
// look even. Labels carry the actual number, so the ramp is never the only channel.
export const HEAT = ['#256abf', '#5598e7', '#cde2fb', '#fab219', '#ec835a', '#d03b3b'] as const;

type Rgb = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
};

function hexToRgb(color: string): Rgb {
  const v = parseInt(color.replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function srgbToOklab([r, g, b]: Rgb): Rgb {
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToSrgb([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}

const HEAT_LAB = HEAT.map(c => srgbToOklab(hexToRgb(c)));

// t = 0 (cool) .. 1 (at its limit) -> sRGB 0..1.
export function heatRgb(t: number): Rgb {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (HEAT_LAB.length - 1);
  const i = Math.min(HEAT_LAB.length - 2, Math.floor(x));
  const f = x - i;
  const a = HEAT_LAB[i], b = HEAT_LAB[i + 1];
  return oklabToSrgb([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
}

export function rgbCss([r, g, b]: Rgb): string {
  const h = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function heatColor(t: number): string {
  return rgbCss(heatRgb(t));
}

// The ramp as a CSS gradient (sampled finely, since CSS would interpolate in sRGB).
export function heatGradient(direction = 'to right'): string {
  const stops = Array.from({ length: 13 }, (_, i) => `${heatColor(i / 12)} ${Math.round((i / 12) * 100)}%`);
  return `linear-gradient(${direction}, ${stops.join(', ')})`;
}
