// Roll up and prune history (every 5 minutes). The host and guest 5-minute series come from
// Proxmox RRD data (collectors/history.js); raw 10-second samples are kept for live views.
// Series with no RRD counterpart (the hardware collector's disk.*, nic.* and cpu.temp, the cpu
// collector's cpu.* and zfs.arc.*) are averaged here from the raw samples so they have history
// beyond the 48 hours raw keeps.
// Pruning is by age only, so a new series needs nothing here unless it needs a rollup.
const { db, transaction } = require('../db');

const RAW_KEEP_S = 48 * 3600;
const ROLLUP_KEEP_S = 90 * 86400;
const RUNS_KEEP_MS = 7 * 86400_000;
const BUCKET_S = 300;
const ROLLUP_SERIES = "(series LIKE 'disk.%' OR series LIKE 'nic.%' OR series LIKE 'cpu.%' OR series LIKE 'zfs.arc.%')";

let rolledUpTo = null; // start of the newest bucket already stored; read from the table on the first run

function rollup(now) {
  const end = now - (now % BUCKET_S); // complete buckets only
  if (rolledUpTo === null) {
    rolledUpTo = db.prepare(`SELECT MAX(ts) AS ts FROM metrics_5m WHERE ${ROLLUP_SERIES}`).get().ts ?? 0;
  }
  // Start at the newest stored bucket (redoing it gives the same result), but never inside a
  // bucket whose first samples have already been pruned.
  const oldest = Math.ceil((now - RAW_KEEP_S) / BUCKET_S) * BUCKET_S;
  const since = Math.max(oldest, rolledUpTo);
  if (since >= end) return rolledUpTo;
  db.prepare(`
    INSERT OR REPLACE INTO metrics_5m (series, ts, avg, max)
    SELECT series, ts - (ts % $size), AVG(value), MAX(value)
    FROM metrics
    WHERE ts >= $since AND ts < $end AND ${ROLLUP_SERIES}
    GROUP BY series, ts - (ts % $size)
  `).run({ size: BUCKET_S, since, end });
  return end - BUCKET_S;
}

function collect() {
  const now = Math.floor(Date.now() / 1000);
  let rolled;
  transaction(() => {
    rolled = rollup(now);
    db.prepare('DELETE FROM metrics WHERE ts < $cutoff').run({ cutoff: now - RAW_KEEP_S });
    db.prepare('DELETE FROM metrics_5m WHERE ts < $cutoff').run({ cutoff: now - ROLLUP_KEEP_S });
    db.prepare('DELETE FROM collector_runs WHERE started_at < $cutoff').run({ cutoff: new Date(Date.now() - RUNS_KEEP_MS).toISOString() });
  });
  rolledUpTo = rolled; // only once the transaction has committed
  return Promise.resolve({ via: 'local' });
}

module.exports = [{ name: 'maintenance', intervalMs: 5 * 60_000, run: collect }];
