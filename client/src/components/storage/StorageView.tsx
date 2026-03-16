import { useState } from 'react';
import { PoolCard } from './PoolCard';
import { IoSection, HISTORY_LEN as _HISTORY_LEN } from './IoSection';
import { DatasetTable } from './DatasetTable';
import { DetailPanel } from './DetailPanel';
import type { Pool, Dataset, Snapshot } from '../../lib/types';

interface IoPoint {
  readBytes: number;
  writeBytes: number;
  readOps: number;
  writeOps: number;
}

interface StorageViewProps {
  data: { pools: Pool[]; datasets: Dataset[]; snapshots: Snapshot[]; timestamp: string } | null;
  loading: boolean;
  error: string | null;
  ioHistory: Record<string, IoPoint[]>;
  onSnapshotCreated: () => void;
}

function Skeleton() {
  return (
    <div className="pools-grid">
      {[0, 1].map(i => (
        <div key={i} className="skeleton-card">
          <div className="shimmer" style={{ width: '40%', height: 24 }} />
          <div className="shimmer" style={{ width: '100%', height: 60 }} />
          <div className="shimmer" style={{ width: '100%', height: 6 }} />
          <div className="shimmer" style={{ width: '100%', height: 80 }} />
        </div>
      ))}
    </div>
  );
}

export function StorageView({ data, loading, error, ioHistory, onSnapshotCreated }: StorageViewProps) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedDs, setSelectedDs] = useState<Dataset | null>(null);

  const filteredDatasets = data?.datasets?.filter(ds => {
    const pool = ds.name.split('/')[0];
    if (filter !== 'all' && pool !== filter) return false;
    if (search && !ds.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }) ?? [];

  const snapsByDataset: Record<string, number> = {};
  for (const sn of (data?.snapshots ?? [])) {
    if (!snapsByDataset[sn.dataset]) snapsByDataset[sn.dataset] = 0;
    snapsByDataset[sn.dataset]++;
  }

  const panelOpen = !!selectedDs;

  return (
    <div className="main-body">
      <div className={`content-area ${panelOpen ? 'panel-open' : ''}`}>
        {error && (
          <div className="error-banner">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.4" />
              <path d="M7 4v3M7 9.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            SSH error: {error}
          </div>
        )}

        <section>
          <div className="section-header">
            <div className="section-title">Storage Pools</div>
            <div className="section-line" />
            {data && <div className="section-title">{data.pools.length} pools</div>}
          </div>
          {loading && !data ? <Skeleton /> : (
            <div className="pools-grid">
              {data?.pools.map(pool => <PoolCard key={pool.name} pool={pool} />)}
            </div>
          )}
        </section>

        <section>
          <div className="section-header">
            <div className="section-title">I/O Activity</div>
            <div className="section-line" />
            <div className="section-title">2s live</div>
          </div>
          <IoSection ioHistory={ioHistory} />
        </section>

        <section>
          <div className="section-header">
            <div className="section-title">Datasets &amp; Volumes</div>
            <div className="section-line" />
            {data && <div className="section-title">{data.datasets.length} entries · {data.snapshots.length} snapshots</div>}
          </div>
          {data && (
            <DatasetTable
              datasets={filteredDatasets}
              snapsByDataset={snapsByDataset}
              selectedDs={selectedDs}
              filter={filter}
              search={search}
              onFilterChange={setFilter}
              onSearchChange={setSearch}
              onSelectDs={setSelectedDs}
            />
          )}
        </section>
      </div>

      <div className={`detail-panel ${panelOpen ? '' : 'hidden'}`}>
        {panelOpen && (
          <DetailPanel
            dataset={selectedDs}
            snapshots={data?.snapshots ?? []}
            onClose={() => setSelectedDs(null)}
            onSnapshotCreated={onSnapshotCreated}
          />
        )}
      </div>
    </div>
  );
}
