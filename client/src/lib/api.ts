import type { CpuHistory, DashboardState, HistoryMatrix, Share } from './types';

async function send<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// Live state over Server-Sent Events. The server sends the full state on connect and again
// whenever a collector finishes; EventSource reconnects on its own after a drop.
export function subscribeState(
  onState: (state: DashboardState) => void,
  onConnection: (connected: boolean) => void,
): () => void {
  const source = new EventSource('/api/events');
  source.addEventListener('state', event => {
    onConnection(true);
    onState(JSON.parse((event as MessageEvent).data));
  });
  source.onerror = () => onConnection(false);
  return () => source.close();
}

export function putSmb(shares: Share[]): Promise<{ shares: Share[] }> {
  return send('/api/smb', json('PUT', { shares }));
}

export function createUser(username: string, password: string) {
  return send('/api/users', json('POST', { username, password }));
}

export function deleteUser(username: string) {
  return send(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
}

export function guestAction(vmid: number, action: string): Promise<{ ok: boolean; output?: string }> {
  return send(`/api/guests/${vmid}/${action}`, { method: 'POST' });
}

export function deleteGuest(vmid: number, confirm: string): Promise<{ ok: boolean }> {
  return send(`/api/guests/${vmid}?confirm=${encodeURIComponent(confirm)}`, { method: 'DELETE' });
}

export function createSnapshot(dataset: string, name: string) {
  return send('/api/snapshots', json('POST', { datasets: [dataset], name }));
}

export function destroySnapshot(snapshot: string) {
  return send('/api/snapshots', json('DELETE', { snapshot }));
}

export function rollbackSnapshot(snapshot: string) {
  return send('/api/snapshots/rollback', json('POST', { snapshot }));
}

export function setUserPassword(username: string, password: string) {
  return send(`/api/users/${encodeURIComponent(username)}/password`, json('PUT', { password }));
}

export async function fetchHistory(metric: string, hours: number): Promise<HistoryMatrix> {
  const res = await fetch(`/api/history?metric=${encodeURIComponent(metric)}&hours=${hours}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchCpuHistory(hours: number): Promise<CpuHistory> {
  const res = await fetch(`/api/cpu?hours=${hours}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
