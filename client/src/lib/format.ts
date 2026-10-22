export function fmtBytes(bytes: number | null | undefined, digits = 1): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : digits)} ${units[i]}`;
}

export function fmtRate(bytesPerSecond: number | null | undefined): string {
  return `${fmtBytes(bytesPerSecond ?? 0)}/s`;
}

export function fmtPct(fraction: number | null | undefined, digits = 0): string {
  return `${((fraction ?? 0) * 100).toFixed(digits)}%`;
}

export function timeAgo(iso: string | number | null | undefined): string {
  if (iso == null) return 'never';
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 86400 * 60) return `${Math.floor(secs / 86400)}d ago`;
  if (secs < 86400 * 365) return `${Math.floor(secs / 86400 / 30)}mo ago`;
  return `${Math.floor(secs / 86400 / 365)}y ago`;
}

export function fmtDuration(seconds?: number | null): string {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtDateTime(iso: string | number): string {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function defaultSnapName(prefix = 'manual'): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
