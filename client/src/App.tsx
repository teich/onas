import { useState, useEffect, useCallback } from 'react';
import { Topbar } from './components/Topbar';
import { StorageView } from './components/storage/StorageView';
import { SharesView } from './components/shares/SharesView';
import { UsersView } from './components/users/UsersView';
import { fetchZfs } from './lib/api';
import type { Pool, Dataset, Snapshot } from './lib/types';

type View = 'storage' | 'shares' | 'users';

const HISTORY_LEN = 60;

interface IoPoint {
  readBytes: number;
  writeBytes: number;
  readOps: number;
  writeOps: number;
}

export function App() {
  const [view, setView] = useState<View>('storage');
  const [data, setData] = useState<{ pools: Pool[]; datasets: Dataset[]; snapshots: Snapshot[]; timestamp: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [ioHistory, setIoHistory] = useState<Record<string, IoPoint[]>>({});

  // Poll iostat every 2s
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/iostat');
        if (!res.ok) return;
        const { pools } = await res.json();
        if (cancelled) return;
        setIoHistory(prev => {
          const next = { ...prev };
          for (const p of pools) {
            const hist = [...(next[p.name] ?? []), {
              readBytes: p.readBytes, writeBytes: p.writeBytes,
              readOps: p.readOps, writeOps: p.writeOps,
            }];
            next[p.name] = hist.slice(-HISTORY_LEN);
          }
          return next;
        });
      } catch (_) { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const json = await fetchZfs();
      setData(json);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="app">
      <Topbar
        view={view}
        setView={setView}
        timestamp={data?.timestamp ?? null}
        refreshing={refreshing}
        onRefresh={() => load(true)}
      />
      {view === 'storage' && (
        <StorageView
          data={data}
          loading={loading}
          error={error}
          ioHistory={ioHistory}
          onSnapshotCreated={() => load(true)}
        />
      )}
      {view === 'shares' && (
        <SharesView datasets={data?.datasets ?? []} />
      )}
      {view === 'users' && (
        <UsersView />
      )}
      <footer className="footer">
        <span>NAS//CTRL — Proxmox ZFS Dashboard</span>
        <span>192.168.2.2 · root · Port 3000</span>
      </footer>
    </div>
  );
}
