import type { Share, HostHealth, SmartDisk } from './types';

export async function fetchZfs() {
  const res = await fetch('/api/zfs');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchIostat() {
  const res = await fetch('/api/iostat');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchDatasetProps(name: string) {
  const res = await fetch(`/api/dataset/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function createSnapshot(dataset: string, snapname: string) {
  const res = await fetch('/api/snapshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataset, snapname }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchGuests() {
  const res = await fetch('/api/guests');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchSmb() {
  const res = await fetch('/api/smb');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function putSmb(shares: Share[]) {
  const res = await fetch('/api/smb', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shares }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchUsers() {
  const res = await fetch('/api/users');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function createUser(username: string, password: string) {
  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function deleteUser(username: string) {
  const res = await fetch(`/api/users/${encodeURIComponent(username)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function guestAction(vmid: number, type: 'lxc' | 'vm', action: string): Promise<{ ok: boolean }> {
  const res = await fetch(`/api/guests/${vmid}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, action }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchHost(): Promise<HostHealth> {
  const res = await fetch('/api/host');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchSmart(): Promise<{ disks: SmartDisk[]; timestamp: string }> {
  const res = await fetch('/api/smart');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function resetUserPassword(username: string, password: string) {
  const res = await fetch(`/api/users/${encodeURIComponent(username)}/password`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}
