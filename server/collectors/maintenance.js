// Prune old history (every 5 minutes). The 5-minute series come from Proxmox RRD data
// (collectors/history.js); raw 10-second samples are only kept for live views.
const { db, transaction } = require('../db');

const RAW_KEEP_S = 48 * 3600;
const ROLLUP_KEEP_S = 90 * 86400;
const RUNS_KEEP_MS = 7 * 86400_000;

function collect() {
  const now = Math.floor(Date.now() / 1000);
  transaction(() => {
    db.prepare('DELETE FROM metrics WHERE ts < $cutoff').run({ cutoff: now - RAW_KEEP_S });
    db.prepare('DELETE FROM metrics_5m WHERE ts < $cutoff').run({ cutoff: now - ROLLUP_KEEP_S });
    db.prepare('DELETE FROM collector_runs WHERE started_at < $cutoff').run({ cutoff: new Date(Date.now() - RUNS_KEEP_MS).toISOString() });
  });
  return Promise.resolve({ via: 'local' });
}

module.exports = [{ name: 'maintenance', intervalMs: 5 * 60_000, run: collect }];
