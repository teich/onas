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
