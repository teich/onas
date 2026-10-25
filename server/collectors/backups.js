// Backups (every 2 minutes): what is backed up where and when, what's scheduled and what's
// running. Three sources:
//   PVE   the vzdump job(s), guests no job covers, recent vzdump runs
//   PBS   datastores and their usage, sync/prune/verify/GC jobs, running and recent tasks, and the
//         newest snapshot of every backup group (time, size, encrypted, verified, complete)
//   WTR   wtr-offsite-backup (ops/host): the unit and timer state, the datasets its script sends,
//         and its progress from the journal of the current or last run
// The whole result is kept as one JSON document; state.js joins it with guests, datasets and
// /etc/onas/backups.json into coverage and findings (server/backups-model.js).
const { replaceTable } = require('../db');
const pve = require('../pve');
const pbs = require('../pbs');
const { sshExec } = require('../ssh');

const OFFSITE_UNIT = 'wtr-offsite-backup';
const OFFSITE_SCRIPT = '/usr/local/sbin/wtr-offsite-backup';
const RECENT_TASKS = 150;

// The newest snapshot of each group, from a datastore's snapshot list. A snapshot still being
// written has no index.json.blob yet; the newest complete one is kept separately.
function latestByGroup(snapshots) {
  const groups = {};
  for (const s of snapshots || []) {
    const key = `${s['backup-type']}/${s['backup-id']}`;
    const files = (s.files || []).map(f => (typeof f === 'string' ? { filename: f } : f));
    const snap = {
      time: s['backup-time'],
      size: s.size ?? null,
      complete: files.some(f => f.filename === 'index.json.blob'),
      encrypted: files.some(f => f['crypt-mode'] === 'encrypt'),
      verified: s.verification?.state ?? null, // ok | failed | null (never)
      archives: files.map(f => f.filename).filter(n => /\.(m|p)?pxar\.didx$|\.img\.fidx$/.test(n)),
      comment: s.comment ?? null,
    };
    const g = groups[key] ||= { count: 0, latest: null, latestComplete: null };
    g.count += 1;
    if (!g.latest || snap.time > g.latest.time) g.latest = snap;
    if (snap.complete && (!g.latestComplete || snap.time > g.latestComplete.time)) g.latestComplete = snap;
  }
  return groups;
}

const pickTask = t => ({
  upid: t.upid,
  type: t.worker_type,
  id: t.worker_id ?? null,
  user: t.user,
  start: t.starttime,
  end: t.endtime ?? null,
  status: t.status ?? null,
});

async function collectPbs() {
  const { data: stores, via } = await pbs.get('/admin/datastore');
  const [usage, sync, prune, verify, gc, running, recent] = await Promise.all([
    pbs.get('/status/datastore-usage'),
    pbs.get('/admin/sync'),
    pbs.get('/admin/prune'),
    pbs.get('/admin/verify'),
    pbs.get('/admin/gc'),
    pbs.get('/nodes/localhost/tasks', { running: true, limit: 50 }),
    pbs.get('/nodes/localhost/tasks', { limit: RECENT_TASKS }),
  ].map(p => p.then(r => r.data)));
  const groups = {};
  for (const s of stores) groups[s.store] = latestByGroup((await pbs.get(`/admin/datastore/${s.store}/snapshots`)).data);
  return {
    via,
    datastores: stores.map(s => {
      const u = (usage || []).find(x => x.store === s.store) || {};
      return {
        store: s.store,
        backend: s['backend-type'] ?? 'filesystem',
        comment: s.comment || '',
        total: u.total ?? null,
        used: u.used ?? null,
        avail: u.avail ?? null,
        estimatedFull: u['estimated-full-date'] ?? null,
        error: u.error ?? null,
      };
    }),
    jobs: [
      ...(sync || []).map(j => ({ kind: 'sync', id: j.id, store: j.store, from: j['remote-store'], schedule: j.schedule, comment: j.comment || '', encryptedOnly: Boolean(j['encrypted-only']), nextRun: j['next-run'] ?? null, lastState: j['last-run-state'] ?? null, lastEnd: j['last-run-endtime'] ?? null, lastUpid: j['last-run-upid'] ?? null })),
      ...(prune || []).map(j => ({ kind: 'prune', id: j.id, store: j.store, schedule: j.schedule, keep: Object.fromEntries(Object.entries(j).filter(([k]) => k.startsWith('keep-'))), nextRun: j['next-run'] ?? null, lastState: j['last-run-state'] ?? null, lastEnd: j['last-run-endtime'] ?? null, lastUpid: j['last-run-upid'] ?? null })),
      ...(verify || []).map(j => ({ kind: 'verify', id: j.id, store: j.store, schedule: j.schedule, nextRun: j['next-run'] ?? null, lastState: j['last-run-state'] ?? null, lastEnd: j['last-run-endtime'] ?? null, lastUpid: j['last-run-upid'] ?? null })),
      ...(gc || []).map(j => ({ kind: 'gc', id: `gc-${j.store}`, store: j.store, schedule: j.schedule, nextRun: j['next-run'] ?? null, lastState: j['last-run-state'] ?? null, lastEnd: j['last-run-endtime'] ?? null, lastUpid: j.upid ?? null, pendingBytes: j['pending-bytes'] ?? null, removedBytes: j['removed-bytes'] ?? null })),
    ],
    running: (running || []).map(pickTask),
    recent: (recent || []).map(pickTask),
    groups,
  };
}

async function collectPve() {
  const [jobs, notBackedUp, tasks] = await Promise.all([
    pve.get('/cluster/backup'),
    pve.get('/cluster/backup-info/not-backed-up'),
    pve.get(`/nodes/${pve.NODE}/tasks`, { typefilter: 'vzdump', limit: 20 }),
  ].map(p => p.then(r => r.data)));
  return {
    jobs: (jobs || []).map(j => ({
      id: j.id,
      enabled: j.enabled !== 0,
      schedule: j.schedule,
      storage: j.storage,
      all: Boolean(j.all),
      vmids: j.vmid ? String(j.vmid).split(',').map(Number) : [],
      exclude: j.exclude ? String(j.exclude).split(',').map(Number) : [],
      mode: j.mode,
      nextRun: j['next-run'] ?? null,
      comment: j.comment || '',
    })),
    notBackedUp: (notBackedUp || []).map(g => Number(g.vmid)),
    tasks: (tasks || []).map(t => ({ upid: t.upid, vmid: t.id ? Number(t.id) : null, start: t.starttime, end: t.endtime ?? null, status: t.status ?? null })),
  };
}

// ---- wtr-offsite-backup on WTR ------------------------------------------------------------
// POSIX sh, no single quotes (wrapped in sh -c '...'). The journal of the unit's latest
// invocation is the current run while it's running, else the last one. Progress is logged every
// minute, so only the last progress line is read, after the per-dataset lines.
const HOST_SCRIPT = `
exec < /dev/null
export LC_ALL=C
echo "@unit"; systemctl show ${OFFSITE_UNIT} --timestamp=unix -p ActiveState -p SubState -p Result -p ExecMainStartTimestamp -p ExecMainExitTimestamp -p ExecMainStatus -p InvocationID
echo "@timer"; systemctl show ${OFFSITE_UNIT}.timer -p ActiveState -p TimersCalendar
for p in NextElapseUSecRealtime LastTriggerUSec; do
  v=$(systemctl show -p $p --value ${OFFSITE_UNIT}.timer); [ -n "$v" ] && echo "$p=@$(date -d "$v" +%s 2>/dev/null)"
done
echo "@script"; cat ${OFFSITE_SCRIPT} 2>/dev/null
inv=$(systemctl show -p InvocationID --value ${OFFSITE_UNIT})
if [ -n "$inv" ]; then
  echo "@journal"
  journalctl -o short-unix --no-pager _SYSTEMD_INVOCATION_ID=$inv 2>/dev/null | grep -E "== |Upload directory|had to backup|Error|failed:" | tail -n 200
  journalctl -o short-unix --no-pager _SYSTEMD_INVOCATION_ID=$inv 2>/dev/null | grep "processed " | tail -n 1
fi
true
`.trim();

function sections(text) {
  const out = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^@(\w+)$/);
    if (m) out.set(m[1], current = []);
    else if (current) current.push(line);
  }
  return out;
}

const props = lines => Object.fromEntries(lines.map(l => l.split(/=(.*)/s)).filter(p => p.length > 1).map(([k, v]) => [k, v]));
const unixOf = v => { const m = /^@(\d+)/.exec(v || ''); return m ? Number(m[1]) : null; };

// What the script sends: `backup <name> <path>` lines (one group each, host/wtr-<name>), or the
// older single-group form's `<name>.pxar:<path>` arguments (one group, host/wtr).
function parseScript(lines) {
  const items = [];
  for (const line of lines) {
    let m;
    if ((m = line.match(/^\s*backup\s+([A-Za-z0-9_.-]+)\s+(\/\S+)\s*$/))) items.push({ name: m[1], path: m[2], group: `host/wtr-${m[1]}` });
    else if ((m = line.match(/^\s*([A-Za-z0-9_-]+)\.pxar:(\/\S+?)\s*\\?\s*$/))) items.push({ name: m[1], path: m[2], group: 'host/wtr' });
  }
  return items;
}

const GIB = 1024 ** 3;
const toBytes = (n, unit) => Number(n) * ({ B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: GIB, TiB: 1024 * GIB }[unit] ?? 1);

// Per dataset in this run: started, finished (with what the payload archive had to send) or
// failed, and the last progress line. Lines look like:
//   1792909824.123 wtr wtr-offsite-backup[123]: Upload directory '/bulk/photos' to '...'
function parseJournal(lines, items) {
  const runs = [];
  let current = null;
  let progress = null;
  const byPath = new Map(items.map(i => [i.path, i]));
  for (const line of lines) {
    const m = line.match(/^(\d+)(?:\.\d+)?\s+\S+\s+\S+:\s(.*)$/);
    if (!m) continue;
    const at = Number(m[1]);
    const msg = m[2];
    let x;
    if ((x = msg.match(/^Upload directory '([^']+)'/))) {
      const item = byPath.get(x[1]) || { name: x[1], path: x[1] };
      if (current && current.state === 'running') current.state = 'done';
      current = { name: item.name, path: x[1], started: at, finished: null, state: 'running', sent: null, total: null };
      runs.push(current);
      progress = null;
    } else if ((x = msg.match(/^(\S+)\.ppxar: had to backup ([\d.]+) (\w+) of ([\d.]+) (\w+)/)) || (x = msg.match(/^(\S+)\.pxar: had to backup ([\d.]+) (\w+) of ([\d.]+) (\w+)/))) {
      if (current) Object.assign(current, { state: 'done', finished: at, sent: toBytes(x[2], x[3]), total: toBytes(x[4], x[5]) });
    } else if ((x = msg.match(/^processed ([\d.]+) (\w+) in .*?, uploaded ([\d.]+) (\w+)/))) {
      progress = { at, processed: toBytes(x[1], x[2]), uploaded: toBytes(x[3], x[4]) };
      if (current) current.progress = progress;
    } else if (/^Error:|failed:/.test(msg)) {
      if (current && current.state === 'running') Object.assign(current, { state: 'failed', finished: at, error: msg });
      else runs.push({ name: null, path: null, started: at, finished: at, state: 'failed', error: msg });
    }
  }
  return runs;
}

async function collectHost() {
  const sec = sections(await sshExec(`sh -c '${HOST_SCRIPT}'`, { timeout: 20_000 }));
  const unit = props(sec.get('unit') || []);
  const timer = props(sec.get('timer') || []);
  const items = parseScript(sec.get('script') || []);
  const running = unit.ActiveState === 'activating' || unit.ActiveState === 'active';
  return {
    unit: {
      active: unit.ActiveState ?? null,
      running,
      result: unit.Result ?? null,          // success | exit-code | ...
      exitStatus: unit.ExecMainStatus != null ? Number(unit.ExecMainStatus) : null,
      startedAt: unixOf(unit.ExecMainStartTimestamp),
      exitedAt: unixOf(unit.ExecMainExitTimestamp),
    },
    timer: {
      active: timer.ActiveState ?? null,
      // Empty while the service runs: systemd starts one catch-up run as soon as it ends.
      nextRun: unixOf(timer.NextElapseUSecRealtime),
      lastTrigger: unixOf(timer.LastTriggerUSec),
      calendar: (timer.TimersCalendar || '').match(/OnCalendar=([^;]+)/)?.[1]?.trim() ?? null,
    },
    items,
    runs: parseJournal(sec.get('journal') || [], items),
  };
}

async function collect() {
  const now = Math.floor(Date.now() / 1000);
  // Each part on its own, so PBS being down doesn't hide the vzdump jobs or the host backup.
  const settle = p => p.then(value => ({ value }), err => ({ error: String(err.message || err).slice(0, 500) }));
  const [p, b, h] = await Promise.all([settle(collectPve()), settle(collectPbs()), settle(collectHost())]);
  if (p.error && b.error && h.error) throw new Error(`pve: ${p.error}; pbs: ${b.error}; host: ${h.error}`);
  replaceTable('backup_state', [{
    id: 1,
    collected_at: now,
    data: JSON.stringify({ pve: p.value ?? null, pbs: b.value ?? null, host: h.value ?? null, errors: { pve: p.error ?? null, pbs: b.error ?? null, host: h.error ?? null } }),
  }]);
  const errors = [p, b, h].map((r, i) => r.error && `${['pve', 'pbs', 'host'][i]}: ${r.error}`).filter(Boolean);
  if (errors.length) throw new Error(`partial: ${errors.join('; ')}`); // shows as failing, data kept
  return { via: b.value?.via ?? 'ssh' };
}

module.exports = [{ name: 'backups', intervalMs: 2 * 60_000, timeoutMs: 110_000, run: collect }];
