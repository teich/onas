// Assemble the dashboard state from the store. Never touches WTR.
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const scheduler = require('./scheduler');

const CONFIG_DIR = process.env.ONAS_CONFIG_DIR || '/etc/onas';
const GUESTS_CONFIG = path.join(CONFIG_DIR, 'guests.json');

function defaultGuestsConfig() {
  return {
    defaults: {
      lxc: { open: 'ssh://lxc-{vmid}' },
      vm: { open: 'https://wtr.giraffe-gamma.ts.net/?console=kvm&vmid={vmid}&novnc=1' },
    },
    guests: {},
  };
}

let guestsConfigCache = { mtimeMs: -1, value: defaultGuestsConfig() };

function readGuestsConfig() {
  let stat;
  try { stat = fs.statSync(GUESTS_CONFIG); } catch (_) { return defaultGuestsConfig(); }
  if (stat.mtimeMs !== guestsConfigCache.mtimeMs) {
    const parsed = JSON.parse(fs.readFileSync(GUESTS_CONFIG, 'utf8'));
    guestsConfigCache = {
      mtimeMs: stat.mtimeMs,
      value: {
        ...defaultGuestsConfig(),
        ...parsed,
        defaults: { ...defaultGuestsConfig().defaults, ...(parsed.defaults || {}) },
        guests: parsed.guests || {},
      },
    };
  }
  return guestsConfigCache.value;
}

function writeGuestsConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(GUESTS_CONFIG, JSON.stringify(config, null, 2) + '\n');
  return readGuestsConfig();
}

const q = {
  host: db.prepare('SELECT * FROM host WHERE id = 1'),
  guests: db.prepare('SELECT * FROM guests ORDER BY vmid'),
  pools: db.prepare('SELECT * FROM pools ORDER BY name'),
  datasets: db.prepare('SELECT * FROM datasets ORDER BY name'),
  snapshots: db.prepare('SELECT * FROM snapshots ORDER BY created_at DESC'),
  disks: db.prepare('SELECT * FROM disks ORDER BY devpath'),
  updates: db.prepare('SELECT * FROM updates ORDER BY package'),
  shares: db.prepare('SELECT * FROM shares ORDER BY name'),
  users: db.prepare('SELECT * FROM smb_users ORDER BY username'),
  actions: db.prepare('SELECT * FROM actions ORDER BY id DESC LIMIT 30'),
  mounts: db.prepare('SELECT * FROM guest_mounts ORDER BY vmid, slot'),
  connections: db.prepare('SELECT * FROM smb_connections ORDER BY share, connected_at'),
};

// onas's own VMID: its bind mounts translate share paths (/srv/media) into host datasets.
const SELF_VMID = Number(process.env.ONAS_VMID || 119);

function shareDataset(sharePath, mounts) {
  let best = null;
  for (const m of mounts) {
    if (m.vmid !== SELF_VMID || !m.target || !m.dataset) continue;
    const t = m.target.replace(/\/+$/, '');
    if ((sharePath === t || sharePath.startsWith(`${t}/`)) && (!best || t.length > best.target.length)) best = m;
  }
  return best?.dataset ?? null;
}

function buildState() {
  const h = q.host.get();
  const mounts = q.mounts.all();
  const collectors = scheduler.status();
  const updates = q.updates.all();
  const count = kind => updates.filter(u => u.kind === kind).length;
  return {
    host: h ? {
      hostname: h.hostname,
      kernel: h.kernel,
      pveVersion: h.pve_version,
      cpu: { pct: (h.cpu || 0) * 100, cores: h.cores || 0 },
      mem: { totalBytes: h.mem_total || 0, usedBytes: h.mem_used || 0 },
      swap: { totalBytes: h.swap_total || 0, usedBytes: h.swap_used || 0 },
      load: { load1: h.load1 ?? 0, load5: h.load5 ?? 0, load15: h.load15 ?? 0 },
      uptimeSeconds: h.uptime || 0,
      timestamp: h.updated_at,
    } : null,
    guests: q.guests.all().map(g => ({
      vmid: g.vmid,
      name: g.name,
      type: g.type,
      status: g.status,
      tags: g.tags,
      lock: g.lock,
      uptime: g.uptime,
      cpu: g.cpu,
      maxcpu: g.maxcpu,
      mem: g.mem,
      maxmem: g.maxmem,
      disk: g.disk,
      maxdisk: g.maxdisk,
      netinRate: g.netin_rate,
      netoutRate: g.netout_rate,
    })),
    pools: q.pools.all().map(p => ({
      name: p.name,
      size: p.size,
      alloc: p.alloc,
      free: p.free,
      frag: p.frag,
      cap: p.size ? Math.round((p.alloc / p.size) * 100) : 0,
      dedup: p.dedup,
      health: p.health,
      scan: p.scan,
      errors: p.errors,
      status: p.status,
      vdevs: JSON.parse(p.vdevs || '[]'),
    })),
    datasets: q.datasets.all().map(d => ({
      name: d.name,
      used: d.used,
      avail: d.avail,
      refer: d.refer,
      mountpoint: d.mountpoint,
      type: d.type,
      volsize: d.volsize,
      usedBySnapshots: d.used_by_snapshots ?? 0,
      usedByDataset: d.used_by_dataset ?? 0,
      usedByChildren: d.used_by_children ?? 0,
      quota: d.quota,
      compressratio: d.compressratio,
    })),
    mounts: mounts.map(m => ({
      vmid: m.vmid,
      slot: m.slot,
      kind: m.kind,
      source: m.source,
      target: m.target,
      dataset: m.dataset,
      readOnly: Boolean(m.read_only),
      size: m.size,
    })),
    snapshots: q.snapshots.all().map(s => ({
      name: s.name,
      dataset: s.dataset,
      snapname: s.snapname,
      usedBytes: s.used || 0,
      referBytes: s.refer || 0,
      createdAt: s.created_at,
    })),
    disks: q.disks.all().map(d => ({
      devpath: d.devpath,
      model: d.model,
      serial: d.serial,
      type: d.type,
      size: d.size,
      used: d.used,
      health: d.health,
      wearout: d.wearout,
      tempC: d.temp_c,
      powerOnHours: d.power_on_hours,
      reallocated: d.reallocated,
    })),
    shares: q.shares.all().map(s => ({
      name: s.name,
      path: s.path,
      dataset: shareDataset(s.path, mounts),
      comment: s.comment,
      readOnly: Boolean(s.read_only),
      guestOk: Boolean(s.guest_ok),
      browseable: Boolean(s.browseable),
      inheritPermissions: Boolean(s.inherit_permissions),
    })),
    smbUsers: q.users.all().map(u => ({ username: u.username, fullName: u.full_name })),
    smbConnections: q.connections.all().map(c => ({
      share: c.share,
      username: c.username,
      machine: c.machine,
      connectedAt: c.connected_at,
      encryption: c.encryption,
      openFiles: c.open_files,
    })),
    updates: {
      count: updates.length,
      patches: count('patch'),
      updates: count('update'),
      upgrades: count('upgrade'),
      packages: updates.map(u => ({ package: u.package, oldVersion: u.old_version, version: u.version, kind: u.kind })),
      checkedAt: collectors.updates?.lastOk ?? null,
    },
    activity: q.actions.all().map(a => ({
      id: a.id,
      timestamp: a.at,
      actor: a.actor,
      action: a.action,
      target: a.target,
      ok: Boolean(a.ok),
      exitCode: a.exit_code,
      output: a.output,
    })),
    guestsConfig: readGuestsConfig(),
    collectors,
    timestamp: new Date().toISOString(),
  };
}

module.exports = { buildState, readGuestsConfig, writeGuestsConfig };
