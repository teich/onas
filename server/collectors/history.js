// 5-minute history for the host and every guest, from Proxmox's own RRD data. The first run
// after start backfills a week (30-minute points) and a day (1-minute points, averaged into
// 5-minute buckets); later runs only fetch the last hour. Includes pressure-stall (PSI) data,
// which /cluster/resources doesn't report.
const { db, transaction } = require('../db');
const pve = require('../pve');

const upsert = db.prepare('INSERT OR REPLACE INTO metrics_5m (series, ts, avg, max) VALUES ($series, $ts, $avg, $max)');

const GUEST_FIELDS = {
  cpu: p => p.cpu,
  mem: p => (p.maxmem ? p.mem / p.maxmem : null),
  netin: p => p.netin,
  netout: p => p.netout,
  psi_cpu: p => p.pressurecpusome,
  psi_io: p => p.pressureiosome,
  psi_mem: p => p.pressurememorysome,
};
const HOST_FIELDS = {
  cpu: p => p.cpu,
  mem: p => (p.memtotal ? p.memused / p.memtotal : null),
  iowait: p => p.iowait,
  netin: p => p.netin,
  netout: p => p.netout,
  psi_cpu: p => p.pressurecpusome,
  psi_io: p => p.pressureiosome,
  psi_mem: p => p.pressurememorysome,
};

let backfilled = false;

// Group RRD points into buckets of `size` seconds; only complete buckets are written, so a
// bucket is never stored from partial data and then left that way.
function bucketize(points, fields, prefix, size) {
  const now = Math.floor(Date.now() / 1000);
  const buckets = new Map();
  for (const point of points) {
    const ts = point.time - (point.time % size);
    if (ts + size > now) continue;
    for (const [name, pick] of Object.entries(fields)) {
      const value = pick(point);
      if (value == null || !Number.isFinite(value)) continue;
      const key = `${prefix}.${name}|${ts}`;
      const b = buckets.get(key) || { series: `${prefix}.${name}`, ts, sum: 0, n: 0, max: -Infinity };
      b.sum += value;
      b.n += 1;
      b.max = Math.max(b.max, value);
      buckets.set(key, b);
    }
  }
  return [...buckets.values()].map(b => ({ series: b.series, ts: b.ts, avg: b.sum / b.n, max: b.max }));
}

async function fetchRrd(path, timeframe) {
  const { data } = await pve.get(path, { timeframe, cf: 'AVERAGE' });
  return data || [];
}

async function collect() {
  const guests = db.prepare('SELECT vmid, type FROM guests').all();
  const targets = [
    { path: `/nodes/${pve.NODE}/rrddata`, prefix: 'host', fields: HOST_FIELDS },
    ...guests.map(g => ({
      path: `/nodes/${pve.NODE}/${g.type === 'lxc' ? 'lxc' : 'qemu'}/${g.vmid}/rrddata`,
      prefix: `guest.${g.vmid}`,
      fields: GUEST_FIELDS,
    })),
  ];
  const frames = backfilled ? [['hour', 300]] : [['week', 1800], ['day', 300]];
  for (const target of targets) {
    for (const [timeframe, size] of frames) {
      const rows = bucketize(await fetchRrd(target.path, timeframe), target.fields, target.prefix, size);
      transaction(() => { for (const row of rows) upsert.run(row); });
    }
  }
  backfilled = true;
  return { via: pve.apiAvailable('read') ? 'api' : 'ssh' };
}

module.exports = [{ name: 'history', intervalMs: 5 * 60_000, timeoutMs: 180_000, run: collect }];
