import { useState, useEffect } from 'react';
import type { Share, Dataset } from '../../lib/types';
import { matchDataset } from './ShareRow';

interface SharePanelProps {
  share: Share | null;
  mode: 'view' | 'edit' | 'new';
  datasets: Dataset[];
  saving: boolean;
  saveStatus: { ok: boolean; msg: string } | null;
  onClose: () => void;
  onEdit: () => void;
  onSave: (share: Share) => void;
  onDelete: (name: string) => void;
}

const EMPTY_SHARE: Share = {
  name: '',
  path: '',
  comment: '',
  readOnly: false,
  guestOk: false,
  browseable: true,
  inheritPermissions: true,
};

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="smb-toggle-row">
      <span className="smb-field-label">{label}</span>
      <label className="smb-checkbox">
        <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} />
        <span className="smb-checkbox-track">
          <span className="smb-checkbox-thumb" />
        </span>
      </label>
    </div>
  );
}

export function SharePanel({
  share, mode, datasets, saving, saveStatus, onClose, onEdit, onSave, onDelete,
}: SharePanelProps) {
  const [form, setForm] = useState<Share>(EMPTY_SHARE);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  useEffect(() => {
    if (mode === 'new') {
      setForm(EMPTY_SHARE);
    } else if (share) {
      setForm({ ...share });
    }
    setDeleteConfirm(false);
  }, [share?.name, mode]);

  const ds = share ? matchDataset(share.path, datasets) : null;

  const handleSave = () => {
    onSave(form);
  };

  if (mode === 'view' && share) {
    return (
      <div className="detail-panel">
        <div className="panel-header">
          <div className="panel-header-top">
            <div className="panel-dataset-name">{share.name}</div>
            <button className="panel-close" onClick={onClose}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="panel-meta">
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)' }}>{share.path}</span>
          </div>
        </div>
        <div className="panel-body">
          <div>
            <div className="panel-section-title">Share Properties</div>
            <div className="props-table">
              {[
                ['Path', share.path],
                ['Comment', share.comment || '—'],
                ['Read Only', share.readOnly ? 'yes' : 'no'],
                ['Guest OK', share.guestOk ? 'yes' : 'no'],
                ['Browseable', share.browseable ? 'yes' : 'no'],
                ['Inherit Permissions', share.inheritPermissions ? 'yes' : 'no'],
              ].map(([k, v]) => (
                <div key={k} className="prop-row">
                  <span className="prop-key">{k}</span>
                  <span className="prop-val">{v}</span>
                </div>
              ))}
            </div>
          </div>

          {ds && (
            <div>
              <div className="panel-section-title">ZFS Dataset</div>
              <div className="smb-dataset-link">
                <span className={`ds-pool-tag ${ds.name.split('/')[0]}-tag`}>{ds.name.split('/')[0]}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text0)' }}>{ds.name}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)' }}>{ds.mountpoint}</span>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, flexDirection: 'column' }}>
            <button className="snap-submit-btn bulk-btn" onClick={onEdit}>Edit Share</button>
            {deleteConfirm ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="smb-delete-btn confirm"
                  onClick={() => { setDeleteConfirm(false); onDelete(share.name); }}
                >
                  Confirm Delete
                </button>
                <button className="snap-submit-btn" style={{ background: 'var(--bg3)', color: 'var(--text1)', border: '1px solid var(--border-hi)' }} onClick={() => setDeleteConfirm(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button className="smb-delete-btn" onClick={() => setDeleteConfirm(true)}>Delete Share</button>
            )}
          </div>

          {saveStatus && (
            <div className={`snap-feedback ${saveStatus.ok ? 'ok' : 'err'}`}>{saveStatus.msg}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="detail-panel">
      <div className="panel-header">
        <div className="panel-header-top">
          <div className="panel-dataset-name">{mode === 'new' ? 'New Share' : `Edit: ${share?.name}`}</div>
          <button className="panel-close" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
      <div className="panel-body">
        <div>
          <div className="panel-section-title">Share Settings</div>
          <div className="smb-field">
            <div className="smb-field-label">Name</div>
            <input
              className="smb-input"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="share-name"
              disabled={mode === 'edit'}
            />
          </div>
          <div className="smb-field">
            <div className="smb-field-label">Path</div>
            <input
              className="smb-input"
              value={form.path}
              onChange={e => setForm(f => ({ ...f, path: e.target.value }))}
              placeholder="/srv/media"
            />
          </div>
          <div className="smb-field">
            <div className="smb-field-label">Comment</div>
            <input
              className="smb-input"
              value={form.comment}
              onChange={e => setForm(f => ({ ...f, comment: e.target.value }))}
              placeholder="Optional description"
            />
          </div>
        </div>

        <div>
          <div className="panel-section-title">Flags</div>
          <ToggleRow label="Read Only" value={form.readOnly} onChange={v => setForm(f => ({ ...f, readOnly: v }))} />
          <ToggleRow label="Guest OK" value={form.guestOk} onChange={v => setForm(f => ({ ...f, guestOk: v }))} />
          <ToggleRow label="Browseable" value={form.browseable} onChange={v => setForm(f => ({ ...f, browseable: v }))} />
          <ToggleRow label="Inherit Permissions" value={form.inheritPermissions} onChange={v => setForm(f => ({ ...f, inheritPermissions: v }))} />
        </div>

        <div style={{ display: 'flex', gap: 10, flexDirection: 'column' }}>
          <button
            className="snap-submit-btn bulk-btn"
            onClick={handleSave}
            disabled={saving || !form.name.trim() || !form.path.trim()}
          >
            {saving ? 'Saving…' : mode === 'new' ? 'Create Share' : 'Save Changes'}
          </button>
          {saveStatus && (
            <div className={`snap-feedback ${saveStatus.ok ? 'ok' : 'err'}`}>{saveStatus.msg}</div>
          )}
        </div>
      </div>
    </div>
  );
}
