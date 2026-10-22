// Guests and node load from /cluster/resources (every 10 s), and the slower-changing node
// details (load average, swap, kernel, PVE version) from /nodes/{node}/status.
const { db, transaction, replaceTable, bindRow } = require('../db');
const pve = require('../pve');

const previous = new Map(); // vmid -> { at, netin, netout } for rate calculation

const upsertHostLoad = db.prepare(`
  INSERT INTO host (id, cpu, cores, mem_total, mem_used, uptime, updated_at)
  VALUES (1, $cpu, $cores, $mem_total, $mem_used, $uptime, $updated_at)
  ON CONFLICT (id) DO UPDATE SET cpu = excluded.cpu, cores = excluded.cores, mem_total = excluded.mem_total,
    mem_used = excluded.mem_used, uptime = excluded.uptime, updated_at = excluded.updated_at
`);

const upsertHostStatus = db.prepare(`
  INSERT INTO host (id, hostname, kernel, pve_version, swap_total, swap_used, load1, load5, load15, updated_at)
  VALUES (1, $hostname, $kernel, $pve_version, $swap_total, $swap_used, $load1, $load5, $load15, $updated_at)
  ON CONFLICT (id) DO UPDATE SET hostname = excluded.hostname, kernel = excluded.kernel, pve_version = excluded.pve_version,
    swap_total = excluded.swap_total, swap_used = excluded.swap_used, load1 = excluded.load1, load5 = excluded.load5,
    load15 = excluded.load15
`);

const insertMetric = db.prepare('INSERT OR REPLACE INTO metrics (series, ts, value) VALUES ($series, $ts, $value)');

async function collectResources() {
  const { data, via } = await pve.get('/cluster/resources');
  const now = Date.now();
  const ts = Math.floor(now / 1000);
  const node = data.find(item => item.type === 'node' && item.node === pve.NODE);
  const guests = data
    .filter(item => (item.type === 'lxc' || item.type === 'qemu') && !item.template)
    .map(item => {
      const vmid = Number(item.vmid);
      const prev = previous.get(vmid);
      const secs = prev ? (now - prev.at) / 1000 : 0;
      const rate = (current, before) => (secs > 0 && current >= before ? (current - before) / secs : null);
      previous.set(vmid, { at: now, netin: item.netin || 0, netout: item.netout || 0 });
      return {
        vmid,
        name: item.name || `guest-${vmid}`,
        type: item.type === 'lxc' ? 'lxc' : 'vm',
        status: item.status || 'unknown',
        tags: item.tags || '',
        lock: item.lock || '',
        uptime: item.uptime || 0,
        cpu: item.cpu || 0,
        maxcpu: item.maxcpu || 0,
        mem: item.mem || 0,
        maxmem: item.maxmem || 0,
        disk: item.disk || 0,
        maxdisk: item.maxdisk || 0,
        netin: item.netin || 0,
        netout: item.netout || 0,
        netin_rate: prev ? rate(item.netin || 0, prev.netin) : null,
        netout_rate: prev ? rate(item.netout || 0, prev.netout) : null,
        diskread: item.diskread || 0,
        diskwrite: item.diskwrite || 0,
      };
    });

  replaceTable('guests', guests);
  transaction(() => {
    if (node) {
      upsertHostLoad.run(bindRow({
        cpu: node.cpu || 0,
        cores: node.maxcpu || 0,
        mem_total: node.maxmem || 0,
        mem_used: node.mem || 0,
        uptime: node.uptime || 0,
        updated_at: new Date(now).toISOString(),
      }));
      insertMetric.run({ series: 'host.cpu', ts, value: node.cpu || 0 });
      insertMetric.run({ series: 'host.mem', ts, value: node.maxmem ? node.mem / node.maxmem : 0 });
    }
    for (const g of guests) {
      if (g.status !== 'running') continue;
      insertMetric.run({ series: `guest.${g.vmid}.cpu`, ts, value: g.cpu });
      insertMetric.run({ series: `guest.${g.vmid}.mem`, ts, value: g.maxmem ? g.mem / g.maxmem : 0 });
      if (g.netin_rate != null) insertMetric.run({ series: `guest.${g.vmid}.netin`, ts, value: g.netin_rate });
      if (g.netout_rate != null) insertMetric.run({ series: `guest.${g.vmid}.netout`, ts, value: g.netout_rate });
    }
  });
  return { via };
}

async function collectNodeStatus() {
  const { data, via } = await pve.get(`/nodes/${pve.NODE}/status`);
  const [load1, load5, load15] = (data.loadavg || []).map(Number);
  upsertHostStatus.run(bindRow({
    hostname: pve.NODE,
    kernel: data['current-kernel']?.release || data.kversion || '',
    pve_version: data.pveversion || '',
    swap_total: data.swap?.total || 0,
    swap_used: data.swap?.used || 0,
    load1, load5, load15,
    updated_at: new Date().toISOString(),
  }));
  return { via };
}

module.exports = [
  { name: 'pve', intervalMs: 10_000, timeoutMs: 15_000, run: collectResources },
  { name: 'node', intervalMs: 30_000, timeoutMs: 15_000, run: collectNodeStatus },
];
