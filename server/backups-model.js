// Turns the `backups` collector's document into what the Backups view shows: findings, what's
// running, the schedule, and coverage (every guest and every dataset: is there a local copy, an
// offsite copy, or a recorded reason there isn't). Pure apart from reading /etc/onas/backups.json.
//
// Where things go on WTR: guests → vzdump → PBS `bulk-backups` (local) → sync job → `b2-offsite`
// (encrypted snapshots only). Bind-mounted data, which vzdump skips → wtr-offsite-backup on the
// host → `b2-offsite` directly, one group per dataset (host/wtr-<name>; host/wtr before 2026-10-25).
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(process.env.ONAS_CONFIG_DIR || '/etc/onas', 'backups.json');
const LOCAL_STORE = process.env.ONAS_LOCAL_STORE || 'bulk-backups';
const OFFSITE_STORE = process.env.ONAS_OFFSITE_STORE || 'b2-offsite';

const HOUR = 3600;
const LOCAL_STALE_S = 26 * HOUR;   // guest backups run daily
const OFFSITE_STALE_S = 50 * HOUR; // the sync runs two hours after them, and can take a while on 25 Mbps
const EMPTY_BYTES = 64 * 1024 ** 2;

let configCache = { mtimeMs: -1, value: { excluded: {}, notes: {} } };

function readConfig() {
  let stat;
  try { stat = fs.statSync(CONFIG_FILE); } catch (_) { return { excluded: {}, notes: {}, missing: true }; }
  if (stat.mtimeMs !== configCache.mtimeMs) {
    try {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      configCache = { mtimeMs: stat.mtimeMs, value: { excluded: parsed.excluded || {}, notes: parsed.notes || {} } };
    } catch (err) {
      configCache = { mtimeMs: stat.mtimeMs, value: { excluded: {}, notes: {}, error: `${CONFIG_FILE}: ${err.message}` } };
    }
  }
  return configCache.value;
}

const snapOut = s => (s ? { time: s.time, size: s.size, encrypted: s.encrypted, verified: s.verified } : null);
const failed = state => state != null && state !== 'OK' && !/^WARNINGS/.test(state);
const levelOf = state => (state == null || state === 'OK' ? null : /^WARNINGS/.test(state) ? 'warning' : 'serious');
const ago = (s, now) => {
  const d = now - s;
  return d < 2 * HOUR ? `${Math.round(d / 60)} min ago` : d < 48 * HOUR ? `${Math.round(d / HOUR)} h ago` : `${Math.round(d / 86400)} days ago`;
};

// A datastore's newest complete snapshot of a guest. vzdump names groups vm/<id> and ct/<id>.
const guestGroup = (groups, store, g) => groups?.[store]?.[`${g.type === 'vm' ? 'vm' : 'ct'}/${g.vmid}`] ?? null;

function inJob(jobs, vmid) {
  return jobs.some(j => j.enabled && ((j.all && !j.exclude.includes(vmid)) || j.vmids.includes(vmid)));
}

// Where one item of the offsite script stands: its newest complete snapshot (its own group, or
// the archive inside the older single host/wtr group), and what the current or last run did.
function offsiteItem(item, groups, runs, unitRunning) {
  const store = groups?.[OFFSITE_STORE] || {};
  let snap = store[item.group]?.latestComplete ?? null;
  const legacy = store['host/wtr']?.latestComplete;
  if (legacy && legacy.archives.some(a => a.startsWith(`${item.name}.`)) && (!snap || legacy.time > snap.time)) snap = legacy;
  const run = [...runs].reverse().find(r => r.path === item.path) ?? null;
  let state = snap ? 'done' : 'never';
  if (run?.state === 'running' && unitRunning) state = 'uploading';
  else if (run?.state === 'failed') state = 'failed';
  else if (run?.state === 'done' && !snap && unitRunning) state = 'sent'; // in a snapshot that isn't finished yet
  return { name: item.name, path: item.path, group: item.group, state, snapshot: snapOut(snap), run: run ? { state: run.state, started: run.started, finished: run.finished, error: run.error ?? null, progress: run.progress ?? null } : null };
}

function buildBackups(row, { guests, datasets, zfsSnapshots, now = Math.floor(Date.now() / 1000) }) {
  if (!row) return null;
  const doc = JSON.parse(row.data);
  const { pve, pbs, host, errors } = doc;
  const config = readConfig();
  const groups = pbs?.groups ?? null;
  const findings = [];
  const add = (level, text, detail) => findings.push({ level, text, detail: detail ?? null });

  for (const [part, err] of Object.entries(errors || {})) if (err) add('warning', `Couldn't read ${part === 'host' ? 'the offsite job on WTR' : part.toUpperCase()}`, err);
  if (config.error) add('warning', 'backups.json is not valid JSON', config.error);

  // ---- Guests -------------------------------------------------------------------------------
  const jobs = pve?.jobs ?? [];
  const guestRows = guests.map(g => {
    const local = guestGroup(groups, LOCAL_STORE, g);
    const offsite = guestGroup(groups, OFFSITE_STORE, g);
    const row = {
      vmid: g.vmid,
      name: g.name,
      type: g.type,
      status: g.status,
      inJob: pve ? inJob(jobs, g.vmid) : null,
      local: snapOut(local?.latestComplete),
      localCount: local?.count ?? 0,
      offsite: snapOut(offsite?.latestComplete),
      offsiteCount: offsite?.count ?? 0,
      problems: [],
    };
    if (groups) {
      const l = row.local, o = row.offsite;
      if (row.inJob === false) row.problems.push({ level: 'warning', text: 'not in any backup job' });
      else if (!l) row.problems.push({ level: 'warning', text: 'no local backup' });
      else if (now - l.time > LOCAL_STALE_S) row.problems.push({ level: 'warning', text: `last local backup ${ago(l.time, now)}` });
      if (l && !l.encrypted) row.problems.push({ level: 'warning', text: 'latest backup not encrypted, so it isn’t synced offsite' });
      else if (l && (!o || now - o.time > OFFSITE_STALE_S)) row.problems.push({ level: 'warning', text: o ? `offsite copy ${ago(o.time, now)}` : 'no offsite copy yet' });
      if (l?.verified === 'failed' || o?.verified === 'failed') row.problems.push({ level: 'critical', text: 'verification failed' });
    }
    return row;
  });
  const guestProblems = guestRows.filter(g => g.problems.length);
  if (guestProblems.length) {
    const worst = guestProblems.some(g => g.problems.some(p => p.level === 'critical')) ? 'critical' : 'warning';
    add(worst, `${guestProblems.length} guest${guestProblems.length > 1 ? 's need' : ' needs'} attention`,
      guestProblems.map(g => `${g.name}: ${g.problems.map(p => p.text).join(', ')}`).join('\n'));
  }

  // ---- Data (datasets) ------------------------------------------------------------------------
  const items = host?.items ?? [];
  const runs = host?.runs ?? [];
  const unitRunning = Boolean(host?.unit?.running);
  const offsiteItems = items.map(i => offsiteItem(i, groups, runs, unitRunning));
  const lastZfs = new Map();
  for (const s of zfsSnapshots) if (!lastZfs.has(s.dataset) || s.createdAt > lastZfs.get(s.dataset)) lastZfs.set(s.dataset, s.createdAt);
  const children = name => datasets.some(d => d.name.startsWith(`${name}/`));
  // The dataset a path lives on: the one with the longest mountpoint containing it.
  const mounts = datasets.filter(d => d.type === 'filesystem' && d.mountpoint?.startsWith('/')).map(d => d.mountpoint.replace(/\/+$/, '') || '/');
  const ownerOf = p => mounts.filter(m => p === m || p.startsWith(`${m}/`)).sort((a, b) => b.length - a.length)[0] ?? null;

  const dataRows = datasets.filter(d => d.type === 'filesystem' && d.mountpoint?.startsWith('/')).map(d => {
    const mp = d.mountpoint.replace(/\/+$/, '');
    const own = d.usedByDataset ?? d.used ?? 0;
    const guest = d.name.match(/\/subvol-(\d+)-disk-\d+$/);
    // pxar doesn't cross into other filesystems, so only the dataset's own path or one of its own
    // folders counts, not a folder that is really a child dataset.
    const covering = offsiteItems.filter(i => ownerOf(i.path.replace(/\/+$/, '')) === mp);
    let coverage;
    if (config.excluded[mp]) coverage = 'excluded';
    else if (guest) coverage = 'guest';
    else if (covering.some(i => i.path.replace(/\/+$/, '') === mp)) coverage = 'offsite';
    else if (covering.length) coverage = 'partial';
    else if (own < EMPTY_BYTES) coverage = 'empty';
    else coverage = 'none';
    return {
      dataset: d.name,
      path: mp,
      sizeBytes: own,
      coverage,
      guest: guest ? Number(guest[1]) : null,
      reason: config.excluded[mp] ?? null,
      note: config.notes[mp] ?? null,
      offsite: covering,
      zfsSnapshotAt: lastZfs.get(d.name) ?? null,
      hasChildren: children(d.name),
    };
  }).filter(r => !(r.coverage === 'empty' && (r.hasChildren || !r.dataset.includes('/'))));

  const uncovered = dataRows.filter(r => r.coverage === 'none');
  if (uncovered.length) {
    add('warning', `${uncovered.length} dataset${uncovered.length > 1 ? 's have' : ' has'} no backup and no recorded reason`,
      uncovered.map(r => r.path).join(', ') + `. Add them to the offsite script (ops/host) or to ${CONFIG_FILE} with a reason.`);
  }
  const never = offsiteItems.filter(i => i.state !== 'done');
  if (never.length && host) {
    const uploading = offsiteItems.find(i => i.state === 'uploading');
    add('warning', `${never.length} of ${offsiteItems.length} offsite datasets have no finished upload yet`,
      `${never.map(i => i.name).join(', ')}${uploading ? `. Uploading ${uploading.name} now.` : ''}`);
  }
  for (const i of offsiteItems.filter(i => i.state === 'failed')) add('serious', `Offsite upload of ${i.name} failed`, i.run?.error);

  // ---- Running now --------------------------------------------------------------------------
  const running = [];
  if (unitRunning) {
    const cur = offsiteItems.find(i => i.state === 'uploading');
    const ds = cur && datasets.find(d => d.mountpoint?.replace(/\/+$/, '') === cur.path.replace(/\/+$/, ''));
    // Logical size: what the backup reads (it counts uncompressed bytes).
    const total = ds ? Math.round((ds.usedByDataset || ds.refer || 0) * (ds.compressratio || 1)) : null;
    const prog = cur?.run?.progress ?? null;
    running.push({
      kind: 'offsite',
      title: 'Offsite backup of host data',
      detail: cur ? `${cur.name} (${cur.path})` : 'starting',
      startedAt: host.unit.startedAt,
      item: cur ? { name: cur.name, path: cur.path, startedAt: cur.run?.started ?? null } : null,
      processedBytes: prog?.processed ?? null,
      uploadedBytes: prog?.uploaded ?? null,
      progressAt: prog?.at ?? null,
      totalBytes: total || null,
      done: offsiteItems.filter(i => i.run?.state === 'done').map(i => i.name),
      queued: (() => { const at = items.findIndex(i => i.name === cur?.name); return at >= 0 ? items.slice(at + 1).map(i => i.name) : []; })(),
    });
  }
  const hostTask = t => t.type === 'backup' && /^[^:]+:host\/wtr/.test(t.id || '');
  for (const t of pbs?.running ?? []) {
    if (hostTask(t)) continue;
    const titles = { syncjob: 'Sync to B2', backup: 'Guest backup to PBS', garbage_collection: 'Garbage collection', verificationjob: 'Verify', verify: 'Verify', prunejob: 'Prune' };
    running.push({ kind: 'pbs', title: titles[t.type] ?? t.type, detail: t.id, startedAt: t.start });
  }
  for (const t of pve?.tasks ?? []) if (t.end == null) running.push({ kind: 'vzdump', title: 'Guest backups (vzdump)', detail: t.vmid ? `guest ${t.vmid}` : 'all guests', startedAt: t.start });

  // ---- Schedule -----------------------------------------------------------------------------
  const startOf = upid => pbs?.recent?.find(t => t.upid === upid)?.start ?? null;
  const schedule = [];
  for (const j of jobs) {
    const last = (pve?.tasks ?? []).find(t => t.vmid == null && t.end != null);
    schedule.push({
      id: j.id, kind: 'vzdump', title: 'Guest backups', what: `${j.all ? 'All guests' : `Guests ${j.vmids.join(', ')}`}${j.exclude.length ? ` except ${j.exclude.join(', ')}` : ''} → ${j.storage} (${LOCAL_STORE})`,
      schedule: j.schedule, enabled: j.enabled, nextRun: j.nextRun, nextNote: null,
      last: last ? { state: last.status, start: last.start, end: last.end } : null,
    });
  }
  const KIND = {
    sync: j => ({ title: 'Sync to B2', what: `${j.encryptedOnly ? 'Encrypted snapshots' : 'Snapshots'} from ${j.from} → ${j.store}` }),
    prune: j => ({ title: 'Prune', what: `${j.store}${Object.keys(j.keep).length ? `: keep ${Object.entries(j.keep).map(([k, v]) => `${v} ${k.slice(5)}`).join(', ')}` : ' (per-group retention)'}` }),
    verify: j => ({ title: 'Verify', what: `${j.store}: re-read and check snapshots` }),
    gc: j => ({ title: 'Garbage collection', what: `${j.store}: free chunks nothing uses` }),
  };
  for (const j of pbs?.jobs ?? []) {
    const k = KIND[j.kind](j);
    const runningNow = (pbs.running || []).some(t => (j.kind === 'sync' && t.type === 'syncjob' && t.id?.endsWith(`::${j.id}`)) || (j.kind === 'gc' && t.type === 'garbage_collection' && t.id === j.store));
    schedule.push({
      id: j.id, kind: j.kind, ...k, schedule: j.schedule, enabled: true, nextRun: j.nextRun,
      // PBS doesn't start a job while its last run is still going; one run follows as soon as it ends.
      nextNote: runningNow ? 'running now; one catch-up run follows if it overruns' : null,
      last: j.lastState || j.lastEnd ? { state: j.lastState, start: startOf(j.lastUpid), end: j.lastEnd } : null,
    });
    if (j.kind === 'prune' && Object.keys(j.keep).length === 0) {
      // Seen on bulk-backups (2026-10-25): its log lists every snapshot as "remove" and warns
      // nightly, though nothing is removed. Retention there comes from the vzdump job.
      add('serious', `Prune job ${j.id} on ${j.store} has no keep options`,
        'Its log lists every snapshot as removed (none are, today) and it warns every night. Retention for this datastore comes from the vzdump job\'s prune settings, so the job can be deleted in PBS.');
      continue;
    }
    const lvl = levelOf(j.lastState);
    if (lvl) add(lvl, `${k.title} (${j.store}): last run ${j.lastState}`, null);
  }
  for (const d of pbs?.datastores ?? []) {
    if (!(pbs.jobs || []).some(j => j.kind === 'verify' && j.store === d.store)) {
      add('warning', `${d.store} has no verify job`, 'Nothing re-reads its snapshots to check they can still be restored. Add one in PBS (Datastore → Verify Jobs).');
    }
  }
  if (host) {
    const u = host.unit;
    schedule.push({
      id: 'wtr-offsite-backup', kind: 'offsite', title: 'Offsite backup of host data',
      what: `${items.map(i => i.name).join(', ')} → ${OFFSITE_STORE}`,
      schedule: host.timer.calendar?.replace(/^\*-\*-\* (\d\d:\d\d)(:00)?$/, '$1') ?? null, enabled: host.timer.active === 'active',
      nextRun: host.timer.nextRun,
      nextNote: u.running ? 'after the current run ends: one catch-up run starts right away, then daily again' : null,
      last: u.running ? { state: 'running', start: u.startedAt, end: null } : u.startedAt ? { state: u.result === 'success' ? 'OK' : `failed (${u.result}${u.exitStatus ? `, exit ${u.exitStatus}` : ''})`, start: u.startedAt, end: u.exitedAt } : null,
    });
    if (!u.running && u.result && u.result !== 'success') add('serious', 'Last offsite backup run failed', `journalctl -u wtr-offsite-backup on WTR (exit ${u.exitStatus ?? '?'})`);
    if (host.timer.active !== 'active') add('serious', 'The offsite backup timer is not active', 'systemctl enable --now wtr-offsite-backup.timer');
  }
  schedule.sort((a, b) => (a.nextRun ?? Infinity) - (b.nextRun ?? Infinity));

  const order = { critical: 0, serious: 1, warning: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);

  return {
    collectedAt: row.collected_at,
    pbsVia: pbs?.via ?? null,
    localStore: LOCAL_STORE,
    offsiteStore: OFFSITE_STORE,
    findings,
    running,
    schedule,
    guests: guestRows,
    data: dataRows,
    offsite: offsiteItems,
    datastores: pbs?.datastores ?? [],
  };
}

module.exports = { buildBackups, failed };
