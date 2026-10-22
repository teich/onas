// SMB shares and users, read locally inside the onas LXC (every minute).
const { replaceTable } = require('../db');
const smb = require('../smb');

async function collect() {
  const [shares, users] = await Promise.all([smb.readShares(), smb.readUsers()]);
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
  return { via: 'local' };
}

module.exports = [{ name: 'smb', intervalMs: 60_000, run: collect }];
