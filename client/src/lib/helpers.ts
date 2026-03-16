export function fmtBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / 1024 ** i).toFixed(i > 1 ? 1 : 0) + ' ' + units[i];
}

export function timeAgo(isoDate: string): string {
  const secs = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 86400 * 30) return `${Math.floor(secs / 86400)}d ago`;
  if (secs < 86400 * 365) return `${Math.floor(secs / 86400 / 30)}mo ago`;
  return `${Math.floor(secs / 86400 / 365)}y ago`;
}

export function fmtDate(isoDate: string): string {
  return new Date(isoDate).toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function parseSize(s: string): number {
  if (!s || s === '-') return 0;
  const m = s.match(/^([\d.]+)([KMGTP]?)/);
  if (!m) return 0;
  const units: Record<string, number> = {
    '': 1, 'K': 1024, 'M': 1024 ** 2, 'G': 1024 ** 3, 'T': 1024 ** 4, 'P': 1024 ** 5,
  };
  return parseFloat(m[1]) * (units[m[2]] || 1);
}

export function defaultSnapName(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}
