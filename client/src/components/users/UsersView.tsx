import { useState, useEffect, useCallback } from 'react';
import type { SmbUser } from '../../lib/types';
import { fetchUsers, createUser, deleteUser } from '../../lib/api';
import { UserRow } from './UserRow';
import { UserPanel } from './UserPanel';

export function UsersView() {
  const [users, setUsers] = useState<SmbUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<SmbUser | null>(null);
  const [panelMode, setPanelMode] = useState<'view' | 'new'>('view');
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchUsers();
      setUsers(data.users ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (username: string, password: string) => {
    setSaving(true);
    setSaveStatus(null);
    try {
      await createUser(username, password);
      await load();
      setPanelMode('view');
      setSelectedUser(null);
      setSaveStatus({ ok: true, msg: `User ${username} created` });
    } catch (e) {
      setSaveStatus({ ok: false, msg: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (username: string) => {
    setSaving(true);
    setSaveStatus(null);
    try {
      await deleteUser(username);
      await load();
      setSelectedUser(null);
      setPanelMode('view');
    } catch (e) {
      setSaveStatus({ ok: false, msg: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const panelOpen = !!selectedUser || panelMode === 'new';

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
            <div className="section-title">SMB Users</div>
            <div className="section-line" />
            {!loading && <div className="section-title">{users.length} users</div>}
            <button
              className="refresh-btn"
              onClick={() => { setSelectedUser(null); setPanelMode('new'); setSaveStatus(null); }}
              style={{ marginLeft: 'auto' }}
            >
              + New User
            </button>
          </div>

          {loading ? (
            <div style={{ padding: '24px', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text2)' }}>
              Loading…
            </div>
          ) : (
            <div className="datasets-table fade-in">
              <div className="user-table-head">
                <div className="th">Username</div>
                <div className="th">Full Name</div>
                <div className="th">Status</div>
              </div>
              <div>
                {users.map(user => (
                  <UserRow
                    key={user.username}
                    user={user}
                    selected={selectedUser?.username === user.username}
                    onClick={() => {
                      if (selectedUser?.username === user.username) {
                        setSelectedUser(null);
                      } else {
                        setSelectedUser(user);
                        setPanelMode('view');
                        setSaveStatus(null);
                      }
                    }}
                  />
                ))}
                {users.length === 0 && (
                  <div style={{ padding: '24px', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text2)' }}>
                    No SMB users
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>

      <div className={`detail-panel ${panelOpen ? '' : 'hidden'}`}>
        {panelOpen && (
          <UserPanel
            user={selectedUser}
            mode={panelMode}
            saving={saving}
            saveStatus={saveStatus}
            onClose={() => { setSelectedUser(null); setPanelMode('view'); setSaveStatus(null); }}
            onCreate={handleCreate}
            onDelete={handleDelete}
          />
        )}
      </div>
    </div>
  );
}
