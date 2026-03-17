import type { Dataset } from '../../lib/types';
import { parseSize } from '../../lib/helpers';

interface DatasetTableProps {
  datasets: Dataset[];
  snapsByDataset: Record<string, number>;
  selectedDs: Dataset | null;
  filter: string;
  search: string;
  onFilterChange: (f: string) => void;
  onSearchChange: (s: string) => void;
  onSelectDs: (ds: Dataset | null) => void;
}

function DatasetRow({
  ds, snapCount, selected, onClick,
}: {
  ds: Dataset;
  snapCount: number;
  selected: boolean;
  onClick: () => void;
}) {
  const depth = (ds.name.match(/\//g) || []).length;
  const shortName = ds.name.split('/').pop()!;
  const pool = ds.name.split('/')[0];
  const isPool = depth === 0;
  const isVolume = ds.type === 'volume';
  const isFast = pool === 'fast';

  const usedBytes = parseSize(ds.used);
  const availBytes = parseSize(ds.avail);
  const totalBytes = usedBytes + availBytes;
  const pct = totalBytes > 0 ? Math.min((usedBytes / totalBytes) * 100, 100) : 0;

  return (
    <div
      className={`table-row ${isPool ? 'is-pool' : ''} ${selected ? 'selected' : ''} ${isFast ? 'fast-row' : ''}`}
      onClick={onClick}
    >
      <div className="td dataset-name-cell">
        <span className="dataset-indent" style={{ width: depth * 16 + 'px' }} />
        {isPool ? (
          <span className={`pool-row-name ${pool}`}>{shortName}</span>
        ) : (
          <>
            <svg className="dataset-icon" viewBox="0 0 14 14" fill="none">
              {isVolume
                ? <><rect x="1" y="3" width="12" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" /><line x1="4" y1="7" x2="10" y2="7" stroke="currentColor" strokeWidth="1.2" /></>
                : <><path d="M2 4h10v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.2" /><path d="M2 4l1.5-2h7L12 4" stroke="currentColor" strokeWidth="1.2" /></>
              }
            </svg>
            <span className="dataset-name-text">{shortName}</span>
            {isVolume && <span className="vol-tag">vol</span>}
          </>
        )}
        {snapCount > 0 && (
          <span className="snap-count-badge has-snaps">
            {snapCount} {snapCount === 1 ? 'snap' : 'snaps'}
          </span>
        )}
      </div>
      <div className="td">{ds.used}</div>
      <div className="td">{ds.avail === '-' ? '—' : ds.avail}</div>
      <div className="td">{ds.refer}</div>
      <div className="td"><span className={`ds-pool-tag ${pool}-tag`}>{pool}</span></div>
      <div className="td size-bar-cell">
        <div className="size-mini-bar"><div className={`size-mini-fill ${pool}-fill`} style={{ width: `${pct}%` }} /></div>
        <span>{pct > 0.5 ? pct.toFixed(1) + '%' : '<1%'}</span>
      </div>
    </div>
  );
}

export function DatasetTable({
  datasets, snapsByDataset, selectedDs, filter, search,
  onFilterChange, onSearchChange, onSelectDs,
}: DatasetTableProps) {
  return (
    <>
      <div className="datasets-controls">
        <div className="filter-tabs">
          <button className={`filter-tab ${filter === 'all' ? 'active' : ''}`} onClick={() => onFilterChange('all')}>All</button>
          <button className={`filter-tab ${filter === 'bulk' ? 'active' : ''}`} onClick={() => onFilterChange('bulk')}>bulk</button>
          <button className={`filter-tab ${filter === 'fast' ? 'active' : ''}`} onClick={() => onFilterChange('fast')}>fast</button>
        </div>
        <input
          className="search-input"
          placeholder="Filter…"
          value={search}
          onChange={e => onSearchChange(e.target.value)}
        />
      </div>
      <div className="datasets-table fade-in">
        <div className="table-head">
          <div className="th">Name</div>
          <div className="th">Used</div>
          <div className="th">Avail</div>
          <div className="th">Refer</div>
          <div className="th">Pool</div>
          <div className="th">Usage</div>
        </div>
        <div>
          {datasets.map(ds => (
            <DatasetRow
              key={ds.name}
              ds={ds}
              snapCount={snapsByDataset[ds.name] ?? 0}
              selected={selectedDs?.name === ds.name}
              onClick={() => onSelectDs(selectedDs?.name === ds.name ? null : ds)}
            />
          ))}
          {datasets.length === 0 && (
            <div style={{ padding: '24px', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text2)' }}>
              No datasets match filter
            </div>
          )}
        </div>
      </div>
    </>
  );
}
