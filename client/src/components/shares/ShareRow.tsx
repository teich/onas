import type { Share, Dataset } from '../../lib/types';

function matchDataset(path: string, datasets: Dataset[]): Dataset | null {
  const candidates = datasets.filter(d =>
    d.mountpoint && d.mountpoint !== '-' && d.mountpoint !== 'none' && path.startsWith(d.mountpoint)
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mountpoint.length - a.mountpoint.length);
  return candidates[0];
}

function Flag({ val }: { val: boolean }) {
  return <span className={val ? 'flag-yes' : 'flag-no'}>{val ? 'yes' : 'no'}</span>;
}

interface ShareRowProps {
  share: Share;
  datasets: Dataset[];
  selected: boolean;
  onClick: () => void;
}

export function ShareRow({ share, datasets, selected, onClick }: ShareRowProps) {
  const ds = matchDataset(share.path, datasets);

  return (
    <div className={`shares-table-row ${selected ? 'selected' : ''}`} onClick={onClick}>
      <div className="td">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{share.name}</span>
          {ds && (
            <span className={`ds-pool-tag ${ds.name.split('/')[0]}-tag`}>
              {ds.name.split('/').pop()}
            </span>
          )}
        </div>
      </div>
      <div className="td" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)' }}>{share.path}</div>
      <div className="td" style={{ color: 'var(--text2)' }}>{share.comment || '—'}</div>
      <div className="td"><Flag val={share.readOnly} /></div>
      <div className="td"><Flag val={share.guestOk} /></div>
      <div className="td"><Flag val={share.browseable} /></div>
      <div className="td"><Flag val={share.inheritPermissions} /></div>
    </div>
  );
}

export { matchDataset };
