// ZFS dataset snapshots. The Proxmox API has no dataset-level snapshot calls, so these use SSH.
const express = require('express');
const { sshCapture } = require('../ssh');
const actions = require('../actions');
const scheduler = require('../scheduler');

const router = express.Router();
const DATASET_RE = /^[a-zA-Z0-9_\-.:\/]+$/;
const SNAPSHOT_RE = /^[a-zA-Z0-9_\-.:\/]+@[a-zA-Z0-9_\-.:]+$/;
const SNAPNAME_RE = /^[a-zA-Z0-9_\-.:]+$/;

async function zfs(res, action, target, command) {
  const result = await sshCapture(command);
  const logged = actions.record(action, target, result);
  scheduler.runNow('zfs').catch(() => {});
  if (!logged.ok) return res.status(500).json({ error: logged.output || 'zfs command failed' });
  res.json({ ok: true });
}

router.post('/snapshots', async (req, res) => {
  const { datasets, name, recursive } = req.body || {};
  if (!Array.isArray(datasets) || datasets.length === 0 || !name) return res.status(400).json({ error: 'datasets and name required' });
  if (!SNAPNAME_RE.test(name)) return res.status(400).json({ error: 'Invalid snapshot name' });
  const bad = datasets.find(ds => !DATASET_RE.test(ds));
  if (bad) return res.status(400).json({ error: `Invalid dataset: ${bad}` });
  const command = datasets.map(ds => `zfs snapshot ${recursive ? '-r ' : ''}${ds}@${name}`).join(' && ');
  await zfs(res, 'snapshot', datasets.map(ds => `${ds}@${name}`).join(', '), command);
});

router.delete('/snapshots', async (req, res) => {
  const { snapshot } = req.body || {};
  if (!snapshot || !SNAPSHOT_RE.test(snapshot)) return res.status(400).json({ error: 'Invalid snapshot' });
  await zfs(res, 'destroy-snapshot', snapshot, `zfs destroy ${snapshot}`);
});

router.post('/snapshots/rollback', async (req, res) => {
  const { snapshot } = req.body || {};
  if (!snapshot || !SNAPSHOT_RE.test(snapshot)) return res.status(400).json({ error: 'Invalid snapshot' });
  await zfs(res, 'rollback', snapshot, `zfs rollback -r ${snapshot}`);
});

module.exports = router;
