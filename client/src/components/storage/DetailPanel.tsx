import { useState, useEffect } from 'react';
import type { Dataset, Snapshot } from '../../lib/types';
import { fmtBytes, timeAgo, fmtDate, defaultSnapName } from '../../lib/helpers';
import { fetchDatasetProps, createSnapshot } from '../../lib/api';

const PROP_LABELS: Record<string, string> = {
  compression: 'Compression',
  compressratio: 'Compress ratio',
  quota: 'Quota',
  reservation: 'Reservation',
  recordsize: 'Record size',
  checksum: 'Checksum',
  atime: 'Access time',
  copies: 'Copies',
  dedup: 'Dedup',
};

interface DetailPanelProps {
  dataset: Dataset | null;
  snapshots: Snapshot[];
  onClose: () => void;
  onSnapshotCreated: () => void;
}

export function DetailPanel({ dataset, snapshots, onClose, onSnapshotCreated }: DetailPanelProps) {
  const [props, setProps] = useState<Record<string, { value: string; source: string }> | null>(null);
  const [propsLoading, setPropsLoading] = useState(false);
  const [snapName, setSnapName] = useState('');
  const [snapStatus, setSnapStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [snapCreating, setSnapCreating] = useState(false);

  const pool = dataset?.name?.split('/')[0] ?? 'bulk';
  const isFast = pool === 'fast';

  useEffect(() => {
    if (!dataset) return;
    setProps(null);
    setSnapStatus(null);
    setSnapName(defaultSnapName());
    setPropsLoading(true);
    fetchDatasetProps(dataset.name)
      .then(d => setProps(d.props))
      .catch(() => setProps({}))
      .finally(() => setPropsLoading(false));
  }, [dataset?.name]);

  const doCreateSnapshot = async () => {
    if (!snapName.trim() || !dataset) return;
    setSnapCreating(true);
    setSnapStatus(null);
    try {
      const data = await createSnapshot(dataset.name, snapName.trim());
      if (data.ok) {
        setSnapStatus({ ok: true, msg: `Created ${data.snapshot}` });
        setSnapName(defaultSnapName());
        onSnapshotCreated();
      } else {
        setSnapStatus({ ok: false, msg: data.error || 'Failed' });
      }
    } catch (e) {
      setSnapStatus({ ok: false, msg: (e as Error).message });
    } finally {
      setSnapCreating(false);
    }
  };

  if (!dataset) return null;

  const dsSnaps = snapshots
    .filter(s => s.dataset === dataset.name)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <div className="detail-panel">
      <div className="panel-header">
        <div className="panel-header-top">
          <div className="panel-dataset-name">{dataset.name}</div>
          <button className="panel-close" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="panel-meta">
          <span className={`ds-pool-tag ${pool}-tag`}>{pool}</span>
          {dataset.type === 'volume' && <span className="vol-tag">volume</span>}
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text2)' }}>
            {dataset.mountpoint !== '-' && dataset.mountpoint !== 'none' ? dataset.mountpoint : ''}
          </span>
        </div>
      </div>

      <div className="panel-body">
        <div>
          <div className="panel-section-title">Usage</div>
          <div className="panel-stats">
            <div className="panel-stat"><div className="panel-stat-label">Used</div><div className="panel-stat-value">{dataset.used}</div></div>
            <div className="panel-stat"><div className="panel-stat-label">Available</div><div className="panel-stat-value">{dataset.avail === '-' ? '—' : dataset.avail}</div></div>
            <div className="panel-stat"><div className="panel-stat-label">Referenced</div><div className="panel-stat-value">{dataset.refer}</div></div>
            <div className="panel-stat"><div className="panel-stat-label">Snapshots</div><div className="panel-stat-value">{dsSnaps.length}</div></div>
          </div>
        </div>

        <div>
          <div className="panel-section-title">Properties</div>
          {propsLoading ? (
            <div className="panel-loading">
              {[80, 60, 70, 55].map((w, i) => <div key={i} className="shimmer" style={{ height: 12, width: `${w}%` }} />)}
            </div>
          ) : props ? (
            <div className="props-table">
              {Object.entries(PROP_LABELS).map(([key, label]) => {
                const p = props[key];
                if (!p) return null;
                const isInherited = p.source === 'inherited' || p.source?.startsWith('inherited');
                return (
                  <div key={key} className="prop-row">
                    <span className="prop-key">{label}</span>
                    <span className={`prop-val ${isInherited ? 'inherited' : ''}`}>{p.value}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        <div>
          <div className="panel-section-title">Snapshots {dsSnaps.length > 0 && `(${dsSnaps.length})`}</div>
          {dsSnaps.length === 0 ? (
            <div className="panel-no-snaps">No snapshots yet</div>
          ) : (
            <div className="panel-snap-list">
              {dsSnaps.map((sn, i) => (
                <div key={i} className="panel-snap-item" style={{ animationDelay: `${i * 0.04}s` }}>
                  <div className="panel-snap-left">
                    <div className="panel-snap-name">
                      <span className="snap-at-sym">@</span>
                      <span>{sn.snapname}</span>
                    </div>
                    <div className="panel-snap-date">{fmtDate(sn.createdAt)}</div>
                  </div>
                  <div className="panel-snap-right">
                    <div className="panel-snap-used">{fmtBytes(sn.usedBytes)}</div>
                    <div className="panel-snap-age">{timeAgo(sn.createdAt)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="panel-section-title">New Snapshot</div>
          <div className="new-snap-form">
            <div className="snap-input-row">
              <span className="snap-prefix">@</span>
              <input
                className="snap-name-input"
                value={snapName}
                onChange={e => setSnapName(e.target.value)}
                placeholder="snapshot-name"
                onKeyDown={e => e.key === 'Enter' && doCreateSnapshot()}
              />
            </div>
            <button
              className={`snap-submit-btn ${isFast ? 'fast-btn' : 'bulk-btn'}`}
              onClick={doCreateSnapshot}
              disabled={snapCreating || !snapName.trim()}
            >
              {snapCreating ? 'Creating…' : '+ Take Snapshot'}
            </button>
            {snapStatus && (
              <div className={`snap-feedback ${snapStatus.ok ? 'ok' : 'err'}`}>
                {snapStatus.msg}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
