import { useState, useEffect } from 'react';
import type { SmbUser } from '../../lib/types';
import { resetUserPassword } from '../../lib/api';

interface UserPanelProps {
  user: SmbUser | null;
  mode: 'view' | 'new';
  saving: boolean;
  saveStatus: { ok: boolean; msg: string } | null;
  onClose: () => void;
  onCreate: (username: string, password: string) => void;
  onDelete: (username: string) => void;
}

export function UserPanel({ user, mode, saving, saveStatus, onClose, onCreate, onDelete }: UserPanelProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [resetPw, setResetPw] = useState('');
  const [resetStatus, setResetStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    setUsername('');
    setPassword('');
    setConfirm('');
    setDeleteConfirm(false);
    setResetPw('');
    setResetStatus(null);
  }, [user?.username, mode]);

  const handleCreate = () => {
    if (password !== confirm) return;
    onCreate(username, password);
  };

  const handleResetPassword = async () => {
    if (!user || !resetPw.trim()) return;
    setResetting(true);
    setResetStatus(null);
    try {
      await resetUserPassword(user.username, resetPw);
      setResetStatus({ ok: true, msg: 'Password updated' });
      setResetPw('');
    } catch (e) {
      setResetStatus({ ok: false, msg: (e as Error).message });
    } finally {
      setResetting(false);
    }
  };

  if (mode === 'new') {
    const mismatch = confirm.length > 0 && password !== confirm;
    return (
      <div className="detail-panel">
        <div className="panel-header">
          <div className="panel-header-top">
            <div className="panel-dataset-name">New User</div>
            <button className="panel-close" onClick={onClose}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
        <div className="panel-body">
          <div>
            <div className="panel-section-title">Create SMB User</div>
            <div className="smb-field">
              <div className="smb-field-label">Username</div>
              <input
                className="smb-input"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="username"
                autoComplete="off"
              />
            </div>
            <div className="smb-field">
              <div className="smb-field-label">Password</div>
              <input
                className="smb-input password-input"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••"
                autoComplete="new-password"
              />
            </div>
            <div className="smb-field">
              <div className="smb-field-label">Confirm Password</div>
              <input
                className={`smb-input password-input ${mismatch ? 'input-error' : ''}`}
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="••••••"
                autoComplete="new-password"
              />
              {mismatch && <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)', marginTop: 4 }}>Passwords don't match</div>}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              className="snap-submit-btn bulk-btn"
              onClick={handleCreate}
              disabled={saving || !username.trim() || !password.trim() || password !== confirm || password.length < 6}
            >
              {saving ? 'Creating…' : 'Create User'}
            </button>
            {saveStatus && (
              <div className={`snap-feedback ${saveStatus.ok ? 'ok' : 'err'}`}>{saveStatus.msg}</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!user) return null;

  const isDisabled = user.flags.includes('D');

  return (
    <div className="detail-panel">
      <div className="panel-header">
        <div className="panel-header-top">
          <div className="panel-dataset-name">{user.username}</div>
          <button className="panel-close" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="panel-meta">
          <span className={`user-status-badge ${isDisabled ? 'disabled' : 'active'}`}>
            {isDisabled ? 'disabled' : 'active'}
          </span>
          {user.fullName && <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)' }}>{user.fullName}</span>}
        </div>
      </div>
      <div className="panel-body">
        <div>
          <div className="panel-section-title">Account Info</div>
          <div className="props-table">
            <div className="prop-row">
              <span className="prop-key">Username</span>
              <span className="prop-val">{user.username}</span>
            </div>
            {user.fullName && (
              <div className="prop-row">
                <span className="prop-key">Full name</span>
                <span className="prop-val">{user.fullName}</span>
              </div>
            )}
            <div className="prop-row">
              <span className="prop-key">Status</span>
              <span className="prop-val">{isDisabled ? 'disabled' : 'active'}</span>
            </div>
          </div>
        </div>

        <div>
          <div className="panel-section-title">Reset Password</div>
          <div className="smb-field">
            <div className="smb-field-label">New Password</div>
            <input
              className="smb-input password-input"
              type="password"
              value={resetPw}
              onChange={e => setResetPw(e.target.value)}
              placeholder="••••••"
              autoComplete="new-password"
              onKeyDown={e => e.key === 'Enter' && handleResetPassword()}
            />
          </div>
          <button
            className="snap-submit-btn bulk-btn"
            onClick={handleResetPassword}
            disabled={resetting || resetPw.length < 6}
            style={{ marginTop: 8 }}
          >
            {resetting ? 'Updating…' : 'Update Password'}
          </button>
          {resetStatus && (
            <div className={`snap-feedback ${resetStatus.ok ? 'ok' : 'err'}`} style={{ marginTop: 8 }}>{resetStatus.msg}</div>
          )}
        </div>

        <div>
          <div className="panel-section-title">Danger Zone</div>
          {deleteConfirm ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="smb-delete-btn confirm"
                onClick={() => { setDeleteConfirm(false); onDelete(user.username); }}
              >
                Confirm Delete
              </button>
              <button
                className="snap-submit-btn"
                style={{ background: 'var(--bg3)', color: 'var(--text1)', border: '1px solid var(--border-hi)' }}
                onClick={() => setDeleteConfirm(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button className="smb-delete-btn" onClick={() => setDeleteConfirm(true)}>
              Delete User
            </button>
          )}
          {saveStatus && (
            <div className={`snap-feedback ${saveStatus.ok ? 'ok' : 'err'}`} style={{ marginTop: 8 }}>{saveStatus.msg}</div>
          )}
        </div>
      </div>
    </div>
  );
}
