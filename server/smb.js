// Samba runs inside this LXC: shares live in smb.conf, users in Samba's passdb.
const fs = require('fs').promises;
const { exec } = require('child_process');

const SMB_CONF = process.env.SMB_CONF || '/etc/samba/smb.conf';
const USERNAME_RE = /^[a-z][a-z0-9_\-]{0,31}$/;
const SHARE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _\-]{0,63}$/;
const SHARE_PATH_RE = /^\/[a-zA-Z0-9\/_.\-]*$/;

function parseSmbConf(raw) {
  const globalRawLines = [];
  const shares = [];
  let section = null;
  let share = null;

  for (const line of raw.split('\n')) {
    const sectionMatch = line.match(/^\s*\[(.+)\]\s*$/);
    if (sectionMatch) {
      if (share) shares.push(share);
      section = sectionMatch[1].trim();
      share = null;
      if (section.toLowerCase() === 'global') {
        section = 'global';
      } else {
        share = { name: section, path: '', comment: '', readOnly: false, guestOk: false, browseable: true, inheritPermissions: true };
      }
      continue;
    }
    if (section === 'global') {
      globalRawLines.push(line);
      continue;
    }
    if (share) {
      const kv = line.match(/^\s*([^=]+?)\s*=\s*(.+?)\s*$/);
      if (!kv) continue;
      const key = kv[1].toLowerCase().replace(/\s+/g, ' ');
      const val = kv[2].trim();
      const bool = val.toLowerCase() === 'yes';
      if (key === 'path') share.path = val;
      else if (key === 'comment') share.comment = val;
      else if (key === 'read only') share.readOnly = bool;
      else if (key === 'guest ok') share.guestOk = bool;
      else if (key === 'browseable') share.browseable = bool;
      else if (key === 'inherit permissions') share.inheritPermissions = bool;
    }
  }
  if (share) shares.push(share);
  return { globalRawLines, shares };
}

function serializeSmbConf(globalRawLines, shares) {
  const b = v => (v ? 'yes' : 'no');
  let out = '[global]\n' + globalRawLines.join('\n') + '\n';
  for (const s of shares) {
    out += `\n[${s.name}]\n`;
    out += `   path = ${s.path}\n`;
    out += `   guest ok = ${b(s.guestOk)}\n`;
    out += `   comment = ${s.comment}\n`;
    out += `   read only = ${b(s.readOnly)}\n`;
    out += `   browseable = ${b(s.browseable)}\n`;
    out += `   inherit permissions = ${b(s.inheritPermissions)}\n`;
  }
  return out;
}

async function readShares() {
  return parseSmbConf(await fs.readFile(SMB_CONF, 'utf8')).shares;
}

function validateShares(shares) {
  for (const s of shares) {
    if (!SHARE_NAME_RE.test(s.name)) return `Invalid share name: ${s.name}`;
    if (!SHARE_PATH_RE.test(s.path)) return `Invalid path: ${s.path}`;
  }
  return null;
}

async function writeShares(shares) {
  const { globalRawLines } = parseSmbConf(await fs.readFile(SMB_CONF, 'utf8'));
  await fs.writeFile(SMB_CONF, serializeSmbConf(globalRawLines, shares));
  await run('smbcontrol smbd reload-config 2>/dev/null || systemctl reload smbd 2>/dev/null || true');
}

// Run a local command; resolves { exitCode, stdout, stderr }. `input` is written to stdin.
function run(cmd, input) {
  return new Promise(resolve => {
    const child = exec(cmd, (err, stdout, stderr) => {
      resolve({ exitCode: err ? (Number.isInteger(err.code) ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || (err && !Number.isInteger(err.code) ? err.message : '') });
    });
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

async function readUsers() {
  const r = await run('pdbedit -L');
  if (r.exitCode !== 0) {
    if (/No users/i.test(r.stderr)) return [];
    throw new Error(r.stderr.trim() || `pdbedit exit ${r.exitCode}`);
  }
  return r.stdout.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.split(':');
    return { username: parts[0] || '', fullName: parts[2] || '' };
  });
}

// Current share connections from `smbstatus --json` (Samba 4.16+): one row per tree connect.
async function readConnections() {
  const r = await run('smbstatus --json');
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `smbstatus exit ${r.exitCode}`);
  const status = JSON.parse(r.stdout);
  const sessions = status.sessions || {};
  const openByShare = {};
  for (const file of Object.values(status.open_files || {})) {
    const opens = Object.keys(file.opens || {}).length || 1;
    openByShare[file.service_path] = (openByShare[file.service_path] || 0) + opens;
  }
  return Object.values(status.tcons || {}).map(tcon => {
    const session = sessions[tcon.session_id] || {};
    return {
      share: tcon.service,
      username: session.username || '',
      machine: tcon.machine || session.remote_machine || '',
      connectedAt: tcon.connected_at || null,
      encryption: tcon.encryption?.cipher && tcon.encryption.cipher !== '-' ? tcon.encryption.cipher : '',
      openFiles: openByShare[tcon.share_path || ''] || 0,
    };
  });
}

async function addUser(username, password) {
  const created = await run(`useradd -M -s /sbin/nologin -G nasusers ${username}`);
  if (created.exitCode !== 0) return created;
  return run(`smbpasswd -a -s ${username}`, `${password}\n${password}\n`);
}

async function setPassword(username, password) {
  return run(`smbpasswd -s ${username}`, `${password}\n${password}\n`);
}

async function removeUser(username) {
  const a = await run(`smbpasswd -x ${username}`);
  const b = await run(`userdel ${username}`);
  return { exitCode: b.exitCode, stdout: [a.stdout, b.stdout].join(''), stderr: [a.stderr, b.stderr].join('') };
}

module.exports = {
  USERNAME_RE, readShares, validateShares, writeShares, readUsers, readConnections, addUser, setPassword, removeUser,
};
