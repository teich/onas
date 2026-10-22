// onas: collectors write WTR's state into SQLite on a schedule; the API and UI read only from
// there, and get pushed updates over Server-Sent Events.
const path = require('path');
const express = require('express');
const { db, DB_PATH } = require('./db');
const scheduler = require('./scheduler');
const pve = require('./pve');
const { buildState, readGuestsConfig, writeGuestsConfig } = require('./state');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');

for (const name of ['pve', 'hardware', 'zfs', 'smb', 'mounts', 'history', 'disks', 'updates', 'maintenance']) {
  for (const def of require(`./collectors/${name}`)) scheduler.register(def);
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC));

app.get('/api/state', (req, res) => res.json(buildState()));

// Push the full state whenever a collector finishes or an action is recorded. Bursts of
// changes are coalesced so a client gets at most one update every 500 ms.
const clients = new Set();
let pending = null;
scheduler.events.on('change', () => {
  if (pending || clients.size === 0) return;
  pending = setTimeout(() => {
    pending = null;
    const payload = `event: state\ndata: ${JSON.stringify(buildState())}\n\n`;
    for (const res of clients) res.write(payload);
  }, 500);
});

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(buildState())}\n\n`);
  clients.add(res);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

app.get('/api/health', (req, res) => {
  const collectors = scheduler.status();
  // Stale: no good run in three intervals (at least two minutes), or none at all since two minutes after start.
  const startedLongAgo = process.uptime() > 120;
  const stale = Object.entries(collectors)
    .filter(([, c]) => c.lastOk
      ? Date.now() - new Date(c.lastOk).getTime() > Math.max(3 * c.intervalMs, 120_000)
      : startedLongAgo)
    .map(([name]) => name);
  res.status(stale.length ? 503 : 200).json({
    ok: stale.length === 0,
    stale,
    pveApi: { read: pve.apiAvailable('read'), write: pve.apiAvailable('write') },
    collectors,
  });
});

// Metric history: ?series=host.cpu&hours=24. Raw samples for up to 6 hours, 5-minute averages beyond.
app.get('/api/metrics', (req, res) => {
  const series = String(req.query.series || '');
  const hours = Math.min(24 * 90, Math.max(1, Number(req.query.hours) || 24));
  if (!/^[A-Za-z0-9._-]+$/.test(series)) return res.status(400).json({ error: 'series required' });
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const points = hours <= 6
    ? db.prepare('SELECT ts, value FROM metrics WHERE series = ? AND ts >= ? ORDER BY ts').all(series, since)
    : db.prepare('SELECT ts, avg AS value, max FROM metrics_5m WHERE series = ? AND ts >= ? ORDER BY ts').all(series, since);
  res.json({ series, hours, points });
});

// A metric for the host and every guest as one matrix, for the activity heatmap:
// ?metric=cpu&hours=24. 5-minute buckets up to 2 days, 30-minute buckets beyond.
const HISTORY_METRICS = new Set(['cpu', 'mem', 'netin', 'netout', 'psi_cpu', 'psi_io', 'psi_mem']);
app.get('/api/history', (req, res) => {
  const metric = String(req.query.metric || 'cpu');
  if (!HISTORY_METRICS.has(metric)) return res.status(400).json({ error: `metric must be one of ${[...HISTORY_METRICS].join(', ')}` });
  const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours) || 24));
  const step = hours <= 48 ? 300 : 1800;
  const now = Math.floor(Date.now() / 1000);
  const end = now - (now % step);
  const start = end - hours * 3600;
  const buckets = [];
  for (let ts = start; ts < end; ts += step) buckets.push(ts);
  const rows = db.prepare(`
    SELECT series, ts - (ts % $step) AS bucket, AVG(avg) AS value, MAX(max) AS peak
    FROM metrics_5m
    WHERE ts >= $start AND ts < $end AND (series = $host OR (series LIKE 'guest.%' AND series LIKE $suffix))
    GROUP BY series, bucket
  `).all({ step, start, end, host: `host.${metric}`, suffix: `%.${metric}` });
  const index = new Map(buckets.map((ts, i) => [ts, i]));
  const bySeries = new Map();
  let max = 0;
  for (const row of rows) {
    const id = row.series === `host.${metric}` ? 'host' : row.series.split('.')[1];
    if (!bySeries.has(id)) bySeries.set(id, new Array(buckets.length).fill(null));
    const i = index.get(row.bucket);
    if (i === undefined) continue;
    bySeries.get(id)[i] = row.value;
    max = Math.max(max, row.value);
  }
  res.json({
    metric, hours, step, start, end, max,
    series: [...bySeries.entries()].map(([id, values]) => ({ id, values })),
  });
});

app.use('/api/guests', require('./routes/guests'));
app.use('/api', require('./routes/storage'));
app.use('/api', require('./routes/smb'));

app.get('/api/config/guests', (req, res) => {
  try {
    res.json(readGuestsConfig());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/config/guests', (req, res) => {
  const config = req.body || {};
  if (config.guests && typeof config.guests !== 'object') return res.status(400).json({ error: 'guests must be an object' });
  try {
    res.json(writeGuestsConfig(config));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

scheduler.start();
app.listen(PORT, '0.0.0.0', () => {
  const via = pve.apiAvailable('read') ? 'Proxmox API' : 'pvesh over SSH (no API token configured)';
  console.log(`onas on :${PORT}, db ${DB_PATH}, reading Proxmox via ${via}`);
});
