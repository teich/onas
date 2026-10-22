import { useMemo, useState } from 'react';
import type { DashboardState, Share } from '../lib/types';
import { createUser, deleteUser, putSmb, setUserPassword } from '../lib/api';
import { ConfirmTyped, CopyText, Empty, Freshness, Meter, Modal, Panel, StatusBadge } from '../components/ui';
import { fmtBytes, timeAgo } from '../lib/format';
import { poolColor } from '../lib/palette';
import { isGuestDisk, poolOf, SELF_VMID } from '../lib/storageModel';

const LAN_HOST = '192.168.2.189';

// `dataset` is derived by onas, not part of smb.conf.
function stripDataset(share: Share): Share {
  const copy = { ...share };
  delete copy.dataset;
  return copy;
}

function smbHost(): string {
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1' ? LAN_HOST : h;
}

function ShareCard({ state, share, onEdit, onDelete, focused }: {
  state: DashboardState;
  share: Share;
  onEdit: () => void;
  onDelete: () => void;
  focused: boolean;
}) {
  const ds = state.datasets.find(d => d.name === share.dataset);
  const pool = share.dataset ? poolOf(share.dataset) : null;
  const conns = state.smbConnections.filter(c => c.share === share.name);
  const capacity = ds ? (ds.quota ?? ds.used + ds.avail) : 0;
  return (
    <article className={`share-card${focused ? ' focused' : ''}`} id={`share-${share.name}`}>
      <header>
        <h3>{share.name}</h3>
        <div className="share-flags">
          <span className={`flag ${share.readOnly ? '' : 'rw'}`}>{share.readOnly ? 'read-only' : 'read-write'}</span>
          {share.guestOk && <StatusBadge level="warning">anyone on the network</StatusBadge>}
          {!share.browseable && <span className="flag">hidden</span>}
        </div>
      </header>
      {share.comment && <p className="muted">{share.comment}</p>}
      <CopyText text={`smb://${smbHost()}/${share.name}`} />
      <div className="share-backing">
        {ds ? (
          <>
            <div className="share-path"><i className="swatch" style={{ background: poolColor(pool!) }} /><code>{ds.name}</code><span className="muted">at {share.path}</span></div>
            <Meter value={ds.used} max={capacity} color={poolColor(pool!)} label={`${fmtBytes(ds.used)} of ${fmtBytes(capacity)}`} />
            <div className="detail-facts">
              <span>{fmtBytes(ds.used)} used</span>
              <span>{ds.quota ? `quota ${fmtBytes(ds.quota)}` : `${fmtBytes(ds.avail)} free in pool`}</span>
              {ds.usedBySnapshots > 0 && <span>{fmtBytes(ds.usedBySnapshots)} in snapshots</span>}
            </div>
          </>
        ) : <StatusBadge level="warning">{share.path} isn’t on a dataset onas can see</StatusBadge>}
      </div>
      <div className="share-conns">
        <div className="detail-label">Connected now</div>
        {conns.length === 0 ? <span className="muted">nobody</span> : conns.map((c, i) => (
          <div key={i} className="detail-line">
            <span>{c.username || 'guest'} <span className="muted">from {c.machine}</span></span>
            <span className="muted">{c.connectedAt ? `since ${timeAgo(c.connectedAt)}` : ''}{c.encryption ? ` · ${c.encryption}` : ''}{c.openFiles ? ` · ${c.openFiles} open` : ''}</span>
          </div>
        ))}
      </div>
      <footer>
        <button onClick={onEdit}>Edit</button>
        <button className="ghost danger-text" onClick={onDelete}>Delete…</button>
      </footer>
    </article>
  );
}

function ShareForm({ state, initial, onClose }: { state: DashboardState; initial: Share | null; onClose: () => void }) {
  const roots = state.mounts.filter(m => m.vmid === SELF_VMID && m.kind === 'bind' && m.target);
  const [form, setForm] = useState<Share>(initial ?? {
    name: '', path: roots[0]?.target ?? '/srv', comment: '', readOnly: false, guestOk: false, browseable: true, inheritPermissions: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Share>) => setForm(f => ({ ...f, ...patch }));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const rest = state.shares.filter(s => s.name !== (initial?.name ?? form.name));
      if (!initial && state.shares.some(s => s.name.toLowerCase() === form.name.toLowerCase())) throw new Error(`A share named ${form.name} already exists`);
      await putSmb([...rest, form].map(stripDataset));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={initial ? `Edit ${initial.name}` : 'New share'} onClose={onClose}>
      <div className="form">
        <label className="field"><span>Name</span><input value={form.name} onChange={e => set({ name: e.target.value })} placeholder="media" disabled={!!initial} /></label>
        <label className="field">
          <span>Folder inside onas</span>
          <input value={form.path} onChange={e => set({ path: e.target.value })} list="share-roots" spellCheck={false} />
          <datalist id="share-roots">{roots.map(r => <option key={r.slot} value={r.target!}>{r.dataset}</option>)}</datalist>
          <small className="muted">Folders under {roots.map(r => r.target).join(', ')} are datasets bind-mounted into onas.</small>
        </label>
        <label className="field"><span>Description</span><input value={form.comment} onChange={e => set({ comment: e.target.value })} /></label>
        <div className="checks">
          <label><input type="checkbox" checked={form.readOnly} onChange={e => set({ readOnly: e.target.checked })} /> Read-only</label>
          <label><input type="checkbox" checked={form.guestOk} onChange={e => set({ guestOk: e.target.checked })} /> Allow without a login</label>
          <label><input type="checkbox" checked={form.browseable} onChange={e => set({ browseable: e.target.checked })} /> Visible when browsing</label>
          <label><input type="checkbox" checked={form.inheritPermissions} onChange={e => set({ inheritPermissions: e.target.checked })} /> New files inherit folder permissions</label>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !form.name || !form.path} onClick={save}>{busy ? 'Saving…' : 'Save and reload Samba'}</button>
        </div>
      </div>
    </Modal>
  );
}

function UsersPanel({ state }: { state: DashboardState }) {
  const [adding, setAdding] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pwFor, setPwFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, done: () => void) => {
    setBusy(true);
    setError(null);
    try { await fn(); done(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const lastSeen = (u: string) => state.smbConnections.filter(c => c.username === u);
  return (
    <Panel title="Users" aside={<button onClick={() => { setAdding(true); setUsername(''); setPassword(''); }}>Add user</button>}>
      <table className="table">
        <thead><tr><th>User</th><th>Connected to</th><th /></tr></thead>
        <tbody>
          {state.smbUsers.map(u => (
            <tr key={u.username}>
              <td><strong>{u.username}</strong>{u.fullName && <span className="muted"> · {u.fullName}</span>}</td>
              <td>{lastSeen(u.username).map(c => c.share).join(', ') || <span className="muted">—</span>}</td>
              <td className="row-actions">
                <button className="ghost" onClick={() => { setPwFor(u.username); setPassword(''); }}>Set password</button>
                <button className="ghost danger-text" onClick={() => setDeleting(u.username)}>Delete…</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {state.smbUsers.length === 0 && <Empty>No Samba users yet.</Empty>}
      {(adding || pwFor) && (
        <Modal title={adding ? 'Add user' : `New password for ${pwFor}`} onClose={() => { setAdding(false); setPwFor(null); }}>
          <div className="form">
            {adding && <label className="field"><span>Username</span><input autoFocus value={username} onChange={e => setUsername(e.target.value.toLowerCase())} placeholder="lowercase, no spaces" /></label>}
            <label className="field"><span>Password</span><input type="password" autoFocus={!adding} value={password} onChange={e => setPassword(e.target.value)} placeholder="at least 6 characters" /></label>
            {adding && <small className="muted">Creates a no-login Linux account in the nasusers group and a matching Samba password.</small>}
            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions">
              <button className="ghost" onClick={() => { setAdding(false); setPwFor(null); }}>Cancel</button>
              <button className="primary" disabled={busy || password.length < 6 || (adding && !username)}
                onClick={() => run(() => adding ? createUser(username, password) : setUserPassword(pwFor!, password), () => { setAdding(false); setPwFor(null); })}>
                {busy ? 'Saving…' : adding ? 'Add user' : 'Set password'}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {deleting && (
        <ConfirmTyped title={`Delete ${deleting}?`} expect={deleting} action="Delete user"
          body={<p>Removes the Samba account and the Linux user. Files they own stay where they are.</p>}
          onConfirm={() => deleteUser(deleting)} onClose={() => setDeleting(null)} />
      )}
    </Panel>
  );
}

export function SharesView({ state, params }: { state: DashboardState; params: URLSearchParams }) {
  const [editing, setEditing] = useState<Share | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Share | null>(null);
  const focus = params.get('share');

  // Datasets on the data pools that onas can't reach (no bind mount into LXC 119).
  const unreachable = useMemo(() => {
    const reachable = state.mounts.filter(m => m.vmid === SELF_VMID && m.dataset).map(m => m.dataset!);
    return state.datasets.filter(d =>
      d.type === 'filesystem' && d.name.split('/').length === 2 && !isGuestDisk(d.name)
      && !reachable.some(r => d.name === r || d.name.startsWith(`${r}/`)),
    );
  }, [state]);

  const connections = state.smbConnections.length;

  return (
    <div className="view">
      <div className="tile-row">
        <div className="stat-tile"><span className="muted">Shares</span><span className="hero-number">{state.shares.length}</span></div>
        <div className="stat-tile"><span className="muted">Users</span><span className="hero-number">{state.smbUsers.length}</span></div>
        <div className="stat-tile"><span className="muted">Connected now</span><span className="hero-number">{connections}</span><Freshness collector={state.collectors.smb} /></div>
        <div className="stat-tile wide">
          <span className="muted">Connect from a Mac</span>
          <span>Finder → Go → Connect to Server, then</span>
          <CopyText text={`smb://${smbHost()}`} />
        </div>
      </div>

      <Panel title="Shares" aside={<button className="primary" onClick={() => setEditing('new')}>New share</button>}>
        <div className="share-grid">
          {state.shares.map(s => (
            <ShareCard key={s.name} state={state} share={s} focused={focus === s.name} onEdit={() => setEditing(s)} onDelete={() => setDeleting(s)} />
          ))}
        </div>
        {state.shares.length === 0 && <Empty>No shares. Create one from a folder under /srv.</Empty>}
      </Panel>

      <div className="two-col">
        <UsersPanel state={state} />
        <Panel title="Not reachable from onas">
          <p className="panel-lede">These datasets aren’t bind-mounted into onas (LXC 119), so they can’t be shared yet. Adding a mount point is a Proxmox change to the container.</p>
          {unreachable.length === 0 ? <Empty>Every top-level dataset is reachable.</Empty> : (
            <div className="detail-list">
              {unreachable.map(d => (
                <div key={d.name} className="detail-line">
                  <span><i className="swatch" style={{ background: poolColor(poolOf(d.name)) }} /><code>{d.name}</code></span>
                  <span className="muted">{fmtBytes(d.used)}{d.quota ? ` of ${fmtBytes(d.quota)} quota` : ''}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {editing && <ShareForm state={state} initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmTyped title={`Delete share ${deleting.name}?`} expect={deleting.name} action="Delete share"
          body={<p>Removes <code>[{deleting.name}]</code> from smb.conf and reloads Samba. The files in {deleting.path} are not touched. Anyone connected loses access.</p>}
          onConfirm={() => putSmb(state.shares.filter(s => s.name !== deleting.name).map(stripDataset))}
          onClose={() => setDeleting(null)} />
      )}
    </div>
  );
}
