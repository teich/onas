// SMB shares, users and live connections, read locally inside the onas LXC (every minute).
const { replaceTable } = require('../db');
const smb = require('../smb');

async function collect() {
  const [shares, users, connections] = await Promise.all([smb.readShares(), smb.readUsers(), smb.readConnections()]);
  replaceTable('shares', shares.map(s => ({
    name: s.name,
    path: s.path,
    comment: s.comment,
    read_only: s.readOnly,
    guest_ok: s.guestOk,
    browseable: s.browseable,
    inherit_permissions: s.inheritPermissions,
  })));
  replaceTable('smb_users', users.map(u => ({ username: u.username, full_name: u.fullName })));
  replaceTable('smb_connections', connections.map(c => ({
    share: c.share,
    username: c.username,
    machine: c.machine,
    connected_at: c.connectedAt,
    encryption: c.encryption,
    open_files: c.openFiles,
  })));
  return { via: 'local' };
}

module.exports = [{ name: 'smb', intervalMs: 30_000, run: collect }];
