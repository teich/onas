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

// ---- Guest Actions ----
app.post('/api/guests/:id/action', express.json(), async (req, res) => {
  const vmid = parseInt(req.params.id, 10);
  if (!vmid || vmid < 1 || vmid > 999999) return res.status(400).json({ error: 'Invalid VMID' });

  const { type, action } = req.body || {};
  const lxcCmds = { start: 'pct start', stop: 'pct stop', shutdown: 'pct shutdown', reboot: 'pct reboot' };
  const vmCmds  = { start: 'qm start',  stop: 'qm stop',  shutdown: 'qm shutdown',  reset: 'qm reset' };

  let cmd;
  if (type === 'lxc' && lxcCmds[action]) cmd = `${lxcCmds[action]} ${vmid}`;
  else if (type === 'vm' && vmCmds[action]) cmd = `${vmCmds[action]} ${vmid}`;
  else return res.status(400).json({ error: 'Invalid type or action' });

  try {
    await sshExec(cmd).catch(err => {
      // Treat "already running/stopped" as non-fatal
      if (/already (running|stopped|shutdown)|not running|already running/i.test(err.message)) return;
      throw err;
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Host Health ----
app.get('/api/host', async (req, res) => {
  try {
    const [memRaw, loadRaw, uptimeRaw, nProcRaw, cpuRaw] = await Promise.all([
      sshExec('cat /proc/meminfo'),
      sshExec('cat /proc/loadavg'),
      sshExec('cat /proc/uptime'),
      sshExec('nproc'),
      sshExec(
        "awk '/^cpu /{u=$2+$4;t=$2+$3+$4+$5+$6+$7+$8;printf \"%d %d\\n\",u,t}' /proc/stat;" +
        "sleep 0.5;" +
        "awk '/^cpu /{u=$2+$4;t=$2+$3+$4+$5+$6+$7+$8;printf \"%d %d\\n\",u,t}' /proc/stat"
      ),
    ]);

    // /proc/meminfo (values in kB)
    const memMap = {};
    for (const line of memRaw.trim().split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) memMap[m[1]] = parseInt(m[2]) * 1024;
    }
    const memTotal = memMap.MemTotal  || 0;
    const memAvail = memMap.MemAvailable || 0;
    const swapTotal = memMap.SwapTotal || 0;
    const swapFree  = memMap.SwapFree  || 0;

    // /proc/loadavg
    const [load1, load5, load15] = loadRaw.trim().split(' ').map(parseFloat);

    // /proc/uptime
    const uptimeSeconds = Math.floor(parseFloat(uptimeRaw.trim().split(' ')[0]));

    // CPU (two samples 500 ms apart)
    const cpuLines = cpuRaw.trim().split('\n');
    const [u1, t1] = cpuLines[0].split(' ').map(Number);
    const [u2, t2] = cpuLines[1] ? cpuLines[1].split(' ').map(Number) : [u1, t1 + 1];
    const cpuPct = t2 - t1 > 0 ? ((u2 - u1) / (t2 - t1)) * 100 : 0;

    res.json({
      cpu: { pct: Math.round(cpuPct * 10) / 10, cores: parseInt(nProcRaw.trim()) || 1 },
      mem: { totalBytes: memTotal, usedBytes: memTotal - memAvail, availBytes: memAvail },
      swap: { totalBytes: swapTotal, usedBytes: swapTotal - swapFree },
      load: { load1, load5, load15 },
      uptimeSeconds,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Disk SMART ----
app.get('/api/smart', async (req, res) => {
  try {
    const statusRaw = await sshExec('zpool status -P');
    const diskSet = new Set();
    for (const line of statusRaw.split('\n')) {
      const m = line.match(/\s+(\/dev\/disk\/by-id\/[^\s]+)\s+/);
      if (m) diskSet.add(m[1].replace(/-part\d+$/, ''));
    }
    const diskPaths = [...diskSet];
    if (diskPaths.length === 0) return res.json({ disks: [], timestamp: new Date().toISOString() });

    // Resolve by-id symlinks → real /dev/sdX or /dev/nvmeXnY
    const realPathsRaw = await sshExec('readlink -f ' + diskPaths.join(' '));
    const realPaths = realPathsRaw.trim().split('\n');

    function shortDev(real) { return real ? real.replace('/dev/', '') : '?'; }
    function modelFromPath(byId) {
      const id = byId.split('/').pop().replace(/^(ata|nvme)-/, '');
      return id.split('_').slice(0, 3).join(' ').slice(0, 40);
    }

    const results = await Promise.allSettled(
      diskPaths.map(dev => sshExec(`smartctl -A -H -j ${dev}`))
    );

    const disks = results.map((r, i) => {
      const dev = diskPaths[i];
      const realPath = realPaths[i] || dev;
      const isNvme = dev.includes('nvme');

      if (r.status === 'rejected') {
        return { device: shortDev(realPath), model: modelFromPath(dev), serial: '', type: isNvme ? 'nvme' : 'ata', tempC: null, healthPassed: null, smartStatus: 'ERROR', powerOnHours: null, reallocatedSectors: null, error: r.reason?.message };
      }

      let d;
      try { d = JSON.parse(r.value); } catch {
        return { device: shortDev(realPath), model: modelFromPath(dev), serial: '', type: isNvme ? 'nvme' : 'ata', tempC: null, healthPassed: null, smartStatus: 'ERROR', powerOnHours: null, reallocatedSectors: null, error: 'parse failed' };
      }

      const model = (d.model_name || d.model_family || modelFromPath(dev)).slice(0, 40);
      const serial = d.serial_number || '';
      const tempC = d.temperature?.current ?? null;
      let powerOnHours = null, reallocSectors = null;

      if (isNvme) {
        powerOnHours = d.nvme_smart_health_information_log?.power_on_hours ?? null;
      } else {
        const attrs = {};
        for (const a of (d.ata_smart_attributes?.table || [])) attrs[a.id] = a;
        reallocSectors = attrs[5]?.raw?.value ?? null;
        powerOnHours = attrs[9]?.raw?.value ?? null;
      }

      return {
        device: shortDev(realPath),
        model,
        serial,
        type: isNvme ? 'nvme' : 'ata',
        tempC,
        healthPassed: d.smart_status?.passed ?? null,
        smartStatus: d.smart_status?.passed === true ? 'PASSED' : d.smart_status?.passed === false ? 'FAILED' : 'UNKNOWN',
        powerOnHours,
        reallocatedSectors: reallocSectors,
      };
    });

    res.json({ disks, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
