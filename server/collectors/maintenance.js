// Roll raw metrics up into 5-minute buckets and prune old history (every 5 minutes).
const { db, transaction } = require('../db');

const RAW_KEEP_S = 48 * 3600;
const ROLLUP_KEEP_S = 90 * 86400;
const RUNS_KEEP_MS = 7 * 86400_000;

function collect() {
  const now = Math.floor(Date.now() / 1000);
  const currentBucket = now - (now % 300);
  transaction(() => {
    // Recompute every complete bucket still covered by raw data; cheap at this scale and self-healing.
    db.prepare(`
      INSERT OR REPLACE INTO metrics_5m (series, ts, avg, max)
      SELECT series, ts - (ts % 300) AS bucket, AVG(value), MAX(value)
      FROM metrics
      WHERE ts >= $since AND ts < $current
      GROUP BY series, bucket
    `).run({ since: currentBucket - 3600, current: currentBucket });
    db.prepare('DELETE FROM metrics WHERE ts < $cutoff').run({ cutoff: now - RAW_KEEP_S });
    db.prepare('DELETE FROM metrics_5m WHERE ts < $cutoff').run({ cutoff: now - ROLLUP_KEEP_S });
    db.prepare('DELETE FROM collector_runs WHERE started_at < $cutoff').run({ cutoff: new Date(Date.now() - RUNS_KEEP_MS).toISOString() });
  });
  return Promise.resolve({ via: 'local' });
}

module.exports = [{ name: 'maintenance', intervalMs: 5 * 60_000, run: collect }];
