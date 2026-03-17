const express = require('express');
const { execFile, exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = 3000;

function sshExec(command) {
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', 'root@192.168.2.2', command], (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

// Parse zpool list -H output
function parseZpoolList(raw) {
  return raw.trim().split('\n').filter(Boolean).map(line => {
    const [name, size, alloc, free, frag, cap, dedup, health] = line.split('\t');
    return { name, size, alloc, free, frag, cap: parseInt(cap) || 0, dedup, health };
  });
}

// Parse zfs list -H output
function parseZfsList(raw) {
  return raw.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.split('\t');
    return {
      name: parts[0],
      used: parts[1],
      avail: parts[2],
      refer: parts[3],
      mountpoint: parts[4],
      type: parts[5],
      volsize: parts[6] === '-' ? null : parts[6],
    };
  });
}

// Parse zpool status output into structured pool data
function parseZpoolStatus(raw) {
  const pools = {};
  let currentPool = null;
  let inConfig = false;
  let configLines = [];

  const lines = raw.split('\n');
  for (const line of lines) {
    const poolMatch = line.match(/^\s*pool:\s+(.+)$/);
    const stateMatch = line.match(/^\s*state:\s+(.+)$/);
    const scanMatch = line.match(/^\s*scan:\s+(.+)$/);
    const errorsMatch = line.match(/^\s*errors:\s+(.+)$/);

    if (poolMatch) {
      if (currentPool && configLines.length) {
        pools[currentPool].configRaw = configLines.join('\n');
      }
      currentPool = poolMatch[1].trim();
      pools[currentPool] = { name: currentPool, state: '', scan: '', errors: '', configRaw: '', vdevs: [] };
      inConfig = false;
      configLines = [];
    } else if (currentPool) {
      if (stateMatch) pools[currentPool].state = stateMatch[1].trim();
      else if (scanMatch) pools[currentPool].scan = scanMatch[1].trim();
      else if (errorsMatch) pools[currentPool].errors = errorsMatch[1].trim();
      else if (line.match(/^\s*config:/)) { inConfig = true; }
      else if (inConfig) { configLines.push(line); }
    }
  }
  if (currentPool && configLines.length) {
    pools[currentPool].configRaw = configLines.join('\n');
  }

  // Parse vdev topology from configRaw
  for (const pool of Object.values(pools)) {
    pool.vdevs = parseVdevTopology(pool.configRaw, pool.name);
  }

  return Object.values(pools);
}

function parseVdevTopology(configRaw, poolName) {
  const lines = configRaw.split('\n').filter(l => l.trim());
  const vdevs = [];
  let currentVdev = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const stateMatch = trimmed.match(/^(.+?)\s+(ONLINE|DEGRADED|FAULTED|OFFLINE|REMOVED|UNAVAIL)\s+(\d+)\s+(\d+)\s+(\d+)$/);
    if (!stateMatch) continue;

    const [, name, state, read, write, cksum] = stateMatch;
    const itemName = name.trim();

    // Skip the pool-name row itself
    if (itemName === poolName) continue;

    const indent = line.search(/\S/);
    const item = { name: itemName, state, read: parseInt(read), write: parseInt(write), cksum: parseInt(cksum), children: [] };

    // vdev groups (mirror-0, raidz2-0) are indented once past the pool row;
    // individual disks are indented further.  We track the first vdev's
    // indent as the "vdev group" level.
    if (!currentVdev || (currentVdev && indent <= (vdevs[0]?._indent ?? indent))) {
      item._indent = indent;
      currentVdev = item;
      vdevs.push(item);
    } else {
      currentVdev.children.push(item);
    }
  }
  return vdevs;
}

app.use(express.static(path.join(__dirname, 'public')));

// iostat: run two samples 1s apart, return the delta (second) sample
app.get('/api/iostat', async (req, res) => {
  try {
    const raw = await sshExec('zpool iostat -Hp 1 2');
    const lines = raw.trim().split('\n').filter(Boolean);
    const half = Math.floor(lines.length / 2);
    const delta = lines.slice(half); // second sample = per-second rates
    const pools = delta.map(line => {
      const [name, alloc, free, readOps, writeOps, readBytes, writeBytes] = line.split('\t');
      return {
        name,
        readOps: parseInt(readOps) || 0,
        writeOps: parseInt(writeOps) || 0,
        readBytes: parseInt(readBytes) || 0,
        writeBytes: parseInt(writeBytes) || 0,
      };
    });
    res.json({ pools, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function parseSnapshots(raw) {
  return raw.trim().split('\n').filter(Boolean).map(line => {
    const [name, usedBytes, referBytes, creationEpoch] = line.split('\t');
    const atIdx = name.indexOf('@');
    return {
      name,
      dataset: name.slice(0, atIdx),
      snapname: name.slice(atIdx + 1),
      usedBytes: parseInt(usedBytes) || 0,
      referBytes: parseInt(referBytes) || 0,
      createdAt: new Date(parseInt(creationEpoch) * 1000).toISOString(),
    };
  });
}

app.get('/api/zfs', async (req, res) => {
  try {
    const [zpoolRaw, zfsRaw, statusRaw, snapRaw] = await Promise.all([
      sshExec('zpool list -H -o name,size,alloc,free,frag,cap,dedup,health'),
      sshExec('zfs list -H -o name,used,avail,refer,mountpoint,type,volsize'),
      sshExec('zpool status'),
      sshExec('zfs list -t snapshot -H -p -o name,used,refer,creation'),
    ]);

    const pools = parseZpoolList(zpoolRaw);
    const datasets = parseZfsList(zfsRaw);
    const statusData = parseZpoolStatus(statusRaw);
    const snapshots = parseSnapshots(snapRaw);

    // Merge status data into pools
    for (const pool of pools) {
      const status = statusData.find(s => s.name === pool.name);
      if (status) {
        pool.scan = status.scan;
        pool.errors = status.errors;
        pool.vdevs = status.vdevs;
        pool.configRaw = status.configRaw;
      }
    }

    res.json({ pools, datasets, snapshots, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('SSH error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Proxmox guest list (LXC + VMs)
app.get('/api/guests', async (req, res) => {
  try {
    const [pctRaw, qmRaw] = await Promise.all([
      sshExec('pct list'),
      sshExec('qm list'),
    ]);
    const guests = [];
    for (const line of pctRaw.trim().split('\n').slice(1).filter(Boolean)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      // columns: VMID Status [Lock] Name — name is always last
      guests.push({ vmid: parseInt(parts[0]), status: parts[1], name: parts[parts.length - 1], type: 'lxc' });
    }
    for (const line of qmRaw.trim().split('\n').slice(1).filter(Boolean)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      // columns: VMID NAME STATUS MEM BOOTDISK PID
      guests.push({ vmid: parseInt(parts[0]), name: parts[1], status: parts[2], type: 'vm' });
    }
    res.json({ guests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dataset detail properties
app.get('/api/dataset/*', async (req, res) => {
  const dataset = req.params[0];
  if (!dataset || dataset.includes(';') || dataset.includes('`')) {
    return res.status(400).json({ error: 'Invalid dataset name' });
  }
  try {
    const raw = await sshExec(`zfs get -H -p compression,compressratio,quota,reservation,recordsize,checksum,atime,copies,dedup ${dataset}`);
    const props = {};
    for (const line of raw.trim().split('\n').filter(Boolean)) {
      const [, name, value, source] = line.split('\t');
      props[name] = { value, source };
    }
    res.json({ dataset, props });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create snapshot
app.post('/api/snapshot', express.json(), async (req, res) => {
  const { dataset, snapname } = req.body || {};
  if (!dataset || !snapname) return res.status(400).json({ error: 'dataset and snapname required' });
  if (/[;`$\\|<>]/.test(dataset + snapname)) return res.status(400).json({ error: 'Invalid characters' });
  try {
    await sshExec(`zfs snapshot ${dataset}@${snapname}`);
    res.json({ ok: true, snapshot: `${dataset}@${snapname}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---- SMB ----

const SMB_CONF = '/etc/samba/smb.conf';

function parseSmbConf(raw) {
  const lines = raw.split('\n');
  const globalRawLines = [];
  const shares = [];
  let currentSection = null;
  let currentShare = null;

  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[(.+)\]\s*$/);
    if (sectionMatch) {
      if (currentShare) shares.push(currentShare);
      currentSection = sectionMatch[1].trim();
      currentShare = null;
      if (currentSection.toLowerCase() === 'global') {
        currentSection = 'global';
      } else {
        currentShare = {
          name: currentSection,
          path: '',
          comment: '',
          readOnly: false,
          guestOk: false,
          browseable: true,
          inheritPermissions: true,
        };
      }
      continue;
    }

    if (currentSection === 'global') {
      globalRawLines.push(line);
      continue;
    }

    if (currentShare) {
      const kvMatch = line.match(/^\s*([^=]+?)\s*=\s*(.+?)\s*$/);
      if (kvMatch) {
        const key = kvMatch[1].toLowerCase().replace(/\s+/g, ' ');
        const val = kvMatch[2].trim();
        const bool = val.toLowerCase() === 'yes';
        if (key === 'path') currentShare.path = val;
        else if (key === 'comment') currentShare.comment = val;
        else if (key === 'read only') currentShare.readOnly = bool;
        else if (key === 'guest ok') currentShare.guestOk = bool;
        else if (key === 'browseable') currentShare.browseable = bool;
        else if (key === 'inherit permissions') currentShare.inheritPermissions = bool;
      }
    }
  }
  if (currentShare) shares.push(currentShare);
  return { globalRawLines, shares };
}

function serializeSmbConf(globalRawLines, shares) {
  const b = v => v ? 'yes' : 'no';
  let out = '[global]\n';
  out += globalRawLines.join('\n') + '\n';
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

app.get('/api/smb', async (req, res) => {
  try {
    const raw = await fs.readFile(SMB_CONF, 'utf8');
    const { shares } = parseSmbConf(raw);
    res.json({ shares, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/smb', express.json(), async (req, res) => {
  const { shares } = req.body || {};
  if (!Array.isArray(shares)) return res.status(400).json({ error: 'shares array required' });

  const nameRe = /^[A-Za-z0-9][A-Za-z0-9 _\-]{0,63}$/;
  const pathRe = /^\/[a-zA-Z0-9\/_.\-]*$/;
  for (const s of shares) {
    if (!nameRe.test(s.name)) return res.status(400).json({ error: `Invalid share name: ${s.name}` });
    if (!pathRe.test(s.path)) return res.status(400).json({ error: `Invalid path: ${s.path}` });
  }

  try {
    const raw = await fs.readFile(SMB_CONF, 'utf8');
    const { globalRawLines } = parseSmbConf(raw);
    const newConfig = serializeSmbConf(globalRawLines, shares);
    await fs.writeFile(SMB_CONF, newConfig);
    await new Promise((resolve) => {
      exec('smbcontrol smbd reload-config 2>/dev/null || systemctl reload smbd 2>/dev/null || true', resolve);
    });
    const fresh = await fs.readFile(SMB_CONF, 'utf8');
    const { shares: freshShares } = parseSmbConf(fresh);
    res.json({ shares: freshShares, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- SMB Users ----

const USERNAME_RE = /^[a-z][a-z0-9_\-]{0,31}$/;

function execLocal(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

app.get('/api/users', async (req, res) => {
  try {
    const raw = await execLocal('pdbedit -L');
    const users = raw.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split(':');
      return {
        username: parts[0] || '',
        fullName: parts[2] || '',
        flags: '',
      };
    });
    res.json({ users, timestamp: new Date().toISOString() });
  } catch (err) {
    // pdbedit returns non-zero when no users, treat as empty
    if (err.message.includes('No users')) res.json({ users: [], timestamp: new Date().toISOString() });
    else res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', express.json(), async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Invalid username' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    await execLocal(`useradd -M -s /sbin/nologin -G nasusers ${username}`);
    await new Promise((resolve, reject) => {
      const child = exec(`smbpasswd -a -s ${username}`, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      });
      child.stdin.write(`${password}\n${password}\n`);
      child.stdin.end();
    });
    res.json({ ok: true, username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:name', async (req, res) => {
  const { name } = req.params;
  if (!USERNAME_RE.test(name)) return res.status(400).json({ error: 'Invalid username' });
  try {
    await execLocal(`smbpasswd -x ${name}`).catch(() => {});
    await execLocal(`userdel ${name}`).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:name/password', express.json(), async (req, res) => {
  const { name } = req.params;
  const { password } = req.body || {};
  if (!USERNAME_RE.test(name)) return res.status(400).json({ error: 'Invalid username' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    await new Promise((resolve, reject) => {
      const child = exec(`smbpasswd -s ${name}`, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      });
      child.stdin.write(`${password}\n${password}\n`);
      child.stdin.end();
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`NAS Dashboard running on http://0.0.0.0:${PORT}`);
});
