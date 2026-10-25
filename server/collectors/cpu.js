// Where WTR's CPU goes (every 10 s): each guest, each host service and the kernel, in cores.
// One SSH round-trip reads /proc/stat, the cgroup v2 CPU counters (lxc/<id>, qemu.slice/<id>.scope,
// system.slice/<unit>), the CPU time of every kernel thread and the ZFS ARC counters. Shares are
// the change since the previous run, kept in memory; the first run after a start has none.
//
// Proxmox's own guest CPU is a fraction of that guest's vCPUs and leaves out the host, so it
// can't say why the host is busy. Here everything is in host cores and adds up: the kernel is
// what the host spent outside every cgroup (kernel threads such as arc_prune, and interrupts).
const { transaction, replaceTable, db } = require('../db');
const { sshExec } = require('../ssh');

// A host service or kernel thread gets its own history series once it uses this much; from then
// on it is written every run (zeros included) so its averages stay right. Guests always are.
const TRACK_CORES = 0.005;
const KTHREAD_TRACK_CORES = 0.01;

const insertMetric = db.prepare('INSERT OR REPLACE INTO metrics (series, ts, value) VALUES ($series, $ts, $value)');

let previous = null; // { stat, cgroups: Map(path -> usec), kthreads: Map(pid -> { name, ticks }), arcPrune }
const tracked = new Set(); // series written every run from now on

// POSIX sh, no single quotes (it is wrapped in sh -c '...'). `cat | awk` rather than awk on the
// files, because a process that exits mid-glob would make mawk stop. Kernel threads are the
// children of kthreadd (pid 2); one whose name has a space is missed and counts as interrupts.
const SCRIPT = `
exec < /dev/null
export LC_ALL=C
echo "@clk $(getconf CLK_TCK) $(nproc)"
echo "@stat"; head -1 /proc/stat
echo "@cgroups"; cd /sys/fs/cgroup && grep -H ^usage_usec lxc/*/cpu.stat qemu.slice/*/cpu.stat system.slice/*/cpu.stat user.slice/cpu.stat init.scope/cpu.stat lxc.monitor/cpu.stat lxc.pivot/cpu.stat 2>/dev/null
echo "@kthreads"; cat /proc/[0-9]*/stat 2>/dev/null | awk "\\$4 == 2 { print \\$1, \\$2, \\$14 + \\$15 }"
echo "@arc"; grep -E "^(size|c|c_max|dnode_size|arc_dnode_limit|arc_prune) " /proc/spl/kstat/zfs/arcstats 2>/dev/null
true
`.trim();

function sections(text) {
  const out = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^@(\S+)(?: (.*))?$/);
    if (m) out.set(m[1], current = { arg: m[2] ?? '', lines: [] });
    else if (current && line) current.lines.push(line);
  }
  return out;
}

// What a cgroup path is. -> { key, kind, ref, name } or null for one we don't report.
function classify(path) {
  let m;
  if ((m = path.match(/^lxc\/(\d+)$/)) || (m = path.match(/^qemu\.slice\/(\d+)\.scope$/))) {
    return { key: `guest-${m[1]}`, kind: 'guest', ref: m[1], name: null };
  }
  if ((m = path.match(/^system\.slice\/(.+)$/))) {
    const unit = m[1].replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    const name = unit.replace(/\.service$/, '');
    return { key: `svc-${name.replace(/[^A-Za-z0-9_-]/g, '_')}`, kind: 'service', ref: unit, name };
  }
  if (path === 'user.slice') return { key: 'user', kind: 'service', ref: 'user.slice', name: 'SSH sessions (incl. onas collectors)' };
  if (path === 'init.scope') return { key: 'svc-systemd', kind: 'service', ref: 'init.scope', name: 'systemd' };
  if (path === 'lxc.monitor' || path === 'lxc.pivot') return { key: 'svc-lxc-monitor', kind: 'service', ref: 'lxc.monitor', name: 'LXC monitors' };
  return null;
}

// Kernel threads come and go by the dozen (kworker/u64:3-events, z_rd_int_7); group them by
// their family name.
const kthreadGroup = name => name.split('/')[0].replace(/[_-]\d+$/, '');

async function collect() {
  const out = await sshExec(`sh -c '${SCRIPT}'`, { timeout: 15_000 });
  const sec = sections(out);
  const [clk, ncpu] = (sec.get('clk')?.arg ?? '').split(' ').map(Number);
  const statLine = sec.get('stat')?.lines[0] ?? '';
  if (!(clk > 0) || !(ncpu > 0) || !statLine.startsWith('cpu ')) throw new Error('unexpected output from WTR (no /proc/stat)');

  // user nice system idle iowait irq softirq steal guest guest_nice; guest time is already in user.
  const f = statLine.trim().split(/\s+/).slice(1).map(Number);
  const stat = { total: f.slice(0, 8).reduce((a, b) => a + b, 0), idle: f[3], iowait: f[4] };
  const cgroups = new Map();
  for (const line of sec.get('cgroups')?.lines ?? []) {
    const m = line.match(/^(.+)\/cpu\.stat:usage_usec (\d+)$/);
    if (m) cgroups.set(m[1], Number(m[2]));
  }
  const kthreads = new Map();
  for (const line of sec.get('kthreads')?.lines ?? []) {
    const m = line.match(/^(\d+) \((.*)\) (\d+)$/);
    if (m) kthreads.set(m[1], { name: m[2], ticks: Number(m[3]) });
  }
  const arc = {};
  for (const line of sec.get('arc')?.lines ?? []) {
    const [name, , value] = line.trim().split(/\s+/);
    arc[name] = Number(value);
  }

  const before = previous;
  previous = { stat, cgroups, kthreads, arcPrune: arc.arc_prune };
  const dTotal = before ? stat.total - before.stat.total : 0;
  if (!(dTotal > 0)) return { via: 'ssh' }; // first run, or the host rebooted: nothing to compare yet

  const elapsedS = dTotal / ncpu / clk;
  const cores = ticks => (ticks / dTotal) * ncpu;
  const busy = cores(dTotal - (stat.idle - before.stat.idle) - (stat.iowait - before.stat.iowait));
  const iowait = cores(stat.iowait - before.stat.iowait);

  // Cgroups: several paths can fold into one consumer (lxc.monitor and lxc.pivot).
  const consumers = new Map();
  let inCgroups = 0;
  for (const [path, usec] of cgroups) {
    const prev = before.cgroups.get(path);
    const who = classify(path);
    if (prev === undefined || usec < prev || !who) continue;
    const c = (usec - prev) / 1e6 / elapsedS;
    inCgroups += c;
    const entry = consumers.get(who.key) || { ...who, cores: 0 };
    entry.cores += c;
    consumers.set(who.key, entry);
  }
  const groups = new Map();
  for (const [pid, t] of kthreads) {
    const prev = before.kthreads.get(pid);
    if (!prev || prev.name !== t.name || t.ticks < prev.ticks) continue;
    const group = kthreadGroup(t.name);
    groups.set(group, (groups.get(group) ?? 0) + cores(t.ticks - prev.ticks));
  }
  for (const [group, c] of groups) {
    consumers.set(`k-${group}`, { key: `k-${group}`, kind: 'kthread', ref: group, name: group, cores: c });
  }
  // /proc/stat is sampled on the scheduler tick while cgroups count exact runtime, so the
  // remainder can come out below what the kernel threads alone used; take the larger.
  const kthreadSum = [...groups.values()].reduce((a, b) => a + b, 0);
  const kernel = Math.max(0, busy - inCgroups, kthreadSum);
  consumers.set('kernel', { key: 'kernel', kind: 'kernel', ref: null, name: 'kernel', cores: kernel });

  const pruneRate = before.arcPrune !== undefined && arc.arc_prune >= before.arcPrune
    ? (arc.arc_prune - before.arcPrune) / elapsedS : null;
  const sampledAt = new Date().toISOString();
  const ts = Math.floor(Date.now() / 1000);
  const rows = [...consumers.values()]
    .filter(c => c.kind === 'guest' || c.kind === 'kernel' || c.cores >= 0.001)
    .sort((a, b) => b.cores - a.cores);

  replaceTable('cpu_host', [{
    id: 1, sampled_at: sampledAt, interval_s: elapsedS, cores: ncpu, busy_cores: busy, iowait_cores: iowait,
    arc_size: arc.size ?? null, arc_target: arc.c ?? null, arc_max: arc.c_max ?? null,
    dnode_size: arc.dnode_size ?? null, dnode_limit: arc.arc_dnode_limit ?? null, arc_prune_rate: pruneRate,
  }]);
  replaceTable('cpu_consumers', rows.map(c => ({ key: c.key, kind: c.kind, ref: c.ref, name: c.name, cores: c.cores })));

  transaction(() => {
    const put = (series, value) => insertMetric.run({ series, ts, value });
    put('cpu.busy', busy);
    put('cpu.iowait', iowait);
    for (const c of consumers.values()) {
      const series = c.kind === 'kthread' ? `cpu.k.${c.ref.replace(/[^A-Za-z0-9_-]/g, '_')}` : `cpu.c.${c.key}`;
      const always = c.kind === 'guest' || c.kind === 'kernel';
      if (!always && !tracked.has(series) && c.cores >= (c.kind === 'kthread' ? KTHREAD_TRACK_CORES : TRACK_CORES)) tracked.add(series);
      if (always || tracked.has(series)) put(series, c.cores);
    }
    // A tracked series whose cgroup or thread has gone (a service that stopped) reads 0.
    for (const series of tracked) {
      const key = series.startsWith('cpu.k.') ? null : series.slice('cpu.c.'.length);
      const seen = key ? consumers.has(key) : [...groups.keys()].some(g => `cpu.k.${g.replace(/[^A-Za-z0-9_-]/g, '_')}` === series);
      if (!seen) put(series, 0);
    }
    if (arc.dnode_size != null && arc.arc_dnode_limit > 0) put('zfs.arc.dnode_ratio', arc.dnode_size / arc.arc_dnode_limit);
    if (pruneRate != null) put('zfs.arc.prune_rate', pruneRate);
  });

  return { via: 'ssh' };
}

module.exports = [{ name: 'cpu', intervalMs: 10_000, timeoutMs: 20_000, run: collect }];
