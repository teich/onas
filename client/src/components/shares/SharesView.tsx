import { useState, useEffect, useCallback } from 'react';
import type { Share, Dataset } from '../../lib/types';
import { fetchSmb, putSmb } from '../../lib/api';
import { ShareRow } from './ShareRow';
import { SharePanel } from './SharePanel';

interface SharesViewProps {
  datasets: Dataset[];
}

export function SharesView({ datasets }: SharesViewProps) {
  const [shares, setShares] = useState<Share[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedShare, setSelectedShare] = useState<Share | null>(null);
  const [panelMode, setPanelMode] = useState<'view' | 'edit' | 'new'>('view');
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchSmb();
      setShares(data.shares ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (share: Share) => {
    setSaving(true);
    setSaveStatus(null);
    try {
      let newShares: Share[];
      if (panelMode === 'new') {
        newShares = [...shares, share];
      } else {
        newShares = shares.map(s => s.name === share.name ? share : s);
      }
      const data = await putSmb(newShares);
      setShares(data.shares ?? newShares);
      const updated = (data.shares ?? newShares).find((s: Share) => s.name === share.name) ?? share;
      setSelectedShare(updated);
      setPanelMode('view');
      setSaveStatus({ ok: true, msg: panelMode === 'new' ? 'Share created' : 'Changes saved' });
    } catch (e) {
      setSaveStatus({ ok: false, msg: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (name: string) => {
    setSaving(true);
    setSaveStatus(null);
    try {
      const newShares = shares.filter(s => s.name !== name);
      await putSmb(newShares);
      setShares(newShares);
      setSelectedShare(null);
      setPanelMode('view');
    } catch (e) {
      setSaveStatus({ ok: false, msg: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const handleNewShare = () => {
    setSelectedShare(null);
    setPanelMode('new');
  };

  const panelOpen = !!selectedShare || panelMode === 'new';

  return (
    <div className="main-body">
      <div className={`content-area ${panelOpen ? 'panel-open' : ''}`}>
        {error && (
          <div className="error-banner">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.4" />
              <path d="M7 4v3M7 9.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            {error}
          </div>
        )}

        <section>
          <div className="section-header">
            <div className="section-title">SMB Shares</div>
            <div className="section-line" />
            {!loading && <div className="section-title">{shares.length} shares</div>}
            <button className="refresh-btn" onClick={handleNewShare} style={{ marginLeft: 'auto' }}>
              + New Share
            </button>
          </div>

          {loading ? (
            <div style={{ padding: '24px', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text2)' }}>
              Loading…
            </div>
          ) : (
            <div className="datasets-table fade-in">
              <div className="shares-table-head">
                <div className="th">Name</div>
                <div className="th">Path</div>
                <div className="th">Comment</div>
                <div className="th">RO</div>
                <div className="th">Guest</div>
                <div className="th">Browse</div>
                <div className="th">InhPerm</div>
              </div>
              <div>
                {shares.map(share => (
                  <ShareRow
                    key={share.name}
                    share={share}
                    datasets={datasets}
                    selected={selectedShare?.name === share.name}
                    onClick={() => {
                      if (selectedShare?.name === share.name && panelMode === 'view') {
                        setSelectedShare(null);
                      } else {
                        setSelectedShare(share);
                        setPanelMode('view');
                        setSaveStatus(null);
                      }
                    }}
                  />
                ))}
                {shares.length === 0 && (
                  <div style={{ padding: '24px', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text2)' }}>
                    No shares configured
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>

      <div className={`detail-panel ${panelOpen ? '' : 'hidden'}`}>
        {panelOpen && (
          <SharePanel
            share={selectedShare}
            mode={panelMode}
            datasets={datasets}
            saving={saving}
            saveStatus={saveStatus}
            onClose={() => { setSelectedShare(null); setPanelMode('view'); setSaveStatus(null); }}
            onEdit={() => setPanelMode('edit')}
            onSave={handleSave}
            onDelete={handleDelete}
          />
        )}
      </div>
    </div>
  );
}
