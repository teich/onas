// Runs each collector on its own interval, never two copies of the same one at once, and
// records every run in collector_runs. A failed run keeps the previous data in place.
const { EventEmitter } = require('events');
const { db } = require('./db');

const events = new EventEmitter();
const collectors = new Map(); // name -> { def, running: Promise|null, timer }

const insertRun = db.prepare(`
  INSERT INTO collector_runs (collector, started_at, duration_ms, ok, error, via)
  VALUES ($collector, $started_at, $duration_ms, $ok, $error, $via)
`);

async function execute(entry) {
  const { def } = entry;
  const startedAt = new Date();
  let ok = 1, error = null, via = null;
  try {
    const result = await withTimeout(def.run(), def.timeoutMs ?? 60_000, def.name);
    via = result?.via ?? null;
  } catch (err) {
    ok = 0;
    error = String(err.message || err).slice(0, 2000);
    console.error(`collector ${def.name}: ${error}`);
  }
  insertRun.run({
    collector: def.name,
    started_at: startedAt.toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    ok,
    error,
    via,
  });
  events.emit('change', def.name);
}

function withTimeout(promise, ms, name) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Run a collector now. If it's already running, wait for that run instead of starting another.
function runNow(name) {
  const entry = collectors.get(name);
  if (!entry) return Promise.reject(new Error(`unknown collector ${name}`));
  if (!entry.running) {
    entry.running = execute(entry).finally(() => { entry.running = null; });
  }
  return entry.running;
}

function schedule(entry, delay) {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(async () => {
    await runNow(entry.def.name);
    schedule(entry, entry.def.intervalMs);
  }, delay);
}

function register(def) {
  collectors.set(def.name, { def, running: null, timer: null });
}

// Start every collector, staggered so they don't all hit WTR in the same instant.
function start() {
  let delay = 0;
  for (const entry of collectors.values()) {
    schedule(entry, delay);
    delay += 250;
  }
}

function status() {
  const latest = db.prepare(`
    SELECT r.collector, r.started_at, r.duration_ms, r.ok, r.error, r.via,
           (SELECT MAX(started_at) FROM collector_runs WHERE collector = r.collector AND ok = 1) AS last_ok
    FROM collector_runs r
    WHERE r.id = (SELECT MAX(id) FROM collector_runs WHERE collector = r.collector)
  `).all();
  const byName = Object.fromEntries(latest.map(row => [row.collector, row]));
  const out = {};
  for (const { def } of collectors.values()) {
    const row = byName[def.name];
    out[def.name] = {
      intervalMs: def.intervalMs,
      lastRun: row?.started_at ?? null,
      lastOk: row?.last_ok ?? null,
      ok: row ? Boolean(row.ok) : null,
      error: row?.error ?? null,
      durationMs: row?.duration_ms ?? null,
      via: row?.via ?? null,
    };
  }
  return out;
}

module.exports = { register, start, runNow, status, events };
