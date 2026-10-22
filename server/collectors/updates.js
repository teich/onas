// Pending host package updates from the Proxmox API's apt cache (hourly). PVE refreshes
// that cache itself every day.
const { replaceTable } = require('../db');
const pve = require('../pve');

function versionParts(version) {
  const match = String(version || '').replace(/^\d+:/, '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : null;
}

function classify(oldVersion, version) {
  const next = versionParts(version);
  const current = versionParts(oldVersion);
  if (!next || !current) return 'update';
  if (next[0] !== current[0]) return 'upgrade';
  if (next[1] !== current[1]) return 'update';
  return 'patch';
}

async function collect() {
  const { data, via } = await pve.get(`/nodes/${pve.NODE}/apt/update`);
  replaceTable('updates', (data || []).map(pkg => ({
    package: pkg.Package,
    old_version: pkg.OldVersion || '',
    version: pkg.Version || '',
    kind: classify(pkg.OldVersion, pkg.Version),
    origin: pkg.Origin || '',
    priority: pkg.Priority || '',
  })));
  return { via };
}

module.exports = [{ name: 'updates', intervalMs: 60 * 60_000, run: collect }];
