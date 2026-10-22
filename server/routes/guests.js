// Guest power actions, PVE snapshots and deletion, through the Proxmox API.
const express = require('express');
const { db } = require('../db');
const pve = require('../pve');
const actions = require('../actions');
const scheduler = require('../scheduler');

const router = express.Router();

const ACTIONS = {
  start: { path: 'status/start' },
  stop: { path: 'status/stop' },
  shutdown: { path: 'status/shutdown' },
  restart: { path: 'status/reboot' },
  pause: { path: 'status/suspend', vmOnly: true },
  resume: { path: 'status/resume', vmOnly: true },
};

function findGuest(vmid) {
  return db.prepare('SELECT vmid, name, type, status FROM guests WHERE vmid = ?').get(vmid);
}

function apiType(guest) {
  return guest.type === 'lxc' ? 'lxc' : 'qemu';
}

// Most guest calls start a PVE task and return its UPID. Wait for it, so the response (and
// the activity log) says whether the action actually worked.
async function finishTask(result) {
  const upid = (result.output || '').trim().split('\n').find(line => line.startsWith('UPID:'));
  if (!result.ok || !upid) return result;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const { data } = await pve.get(`/nodes/${pve.NODE}/tasks/${encodeURIComponent(upid)}/status`);
    if (data.status === 'stopped') {
      const ok = data.exitstatus === 'OK' || /^WARNINGS/.test(data.exitstatus || '');
      return { ...result, ok, exitCode: ok ? 0 : 1, output: `${upid}\n${data.exitstatus}` };
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return { ...result, output: `${upid}\nstill running after 90 s` };
}

function parseVmid(req, res) {
  const vmid = parseInt(req.params.id, 10);
  if (!vmid || vmid < 1 || vmid > 999999) {
    res.status(400).json({ error: 'Invalid VMID' });
    return null;
  }
  return vmid;
}

router.post('/:id/:action(start|stop|shutdown|restart|pause|resume|snapshot)', async (req, res) => {
  const vmid = parseVmid(req, res);
  if (!vmid) return;
  const guest = findGuest(vmid);
  if (!guest) return res.status(404).json({ error: 'Guest not found' });
  const action = req.params.action;
  const base = `/nodes/${pve.NODE}/${apiType(guest)}/${vmid}`;

  let result;
  if (action === 'snapshot') {
    const snapname = `manual-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}`;
    result = await finishTask(await pve.post(`${base}/snapshot`, { snapname, description: 'Taken from onas' }));
  } else {
    const def = ACTIONS[action];
    if (def.vmOnly && guest.type !== 'vm') return res.status(400).json({ error: `${action} is not available for ${guest.type}` });
    result = await finishTask(await pve.post(`${base}/${def.path}`));
  }
  const logged = actions.record(action, `${guest.type} ${vmid} (${guest.name})`, result);
  scheduler.runNow('pve').catch(() => {});
  if (!logged.ok) return res.status(500).json({ error: logged.output || 'action failed' });
  res.json({ ok: true, output: logged.output });
});

router.delete('/:id', async (req, res) => {
  const vmid = parseVmid(req, res);
  if (!vmid) return;
  if (String(req.query.confirm) !== String(vmid)) return res.status(400).json({ error: 'typed VMID confirmation required' });
  const guest = findGuest(vmid);
  if (!guest) return res.status(404).json({ error: 'Guest not found' });
  if (guest.status === 'running') return res.status(409).json({ error: 'Refusing to delete a running guest' });
  const result = await finishTask(await pve.del(`/nodes/${pve.NODE}/${apiType(guest)}/${vmid}`));
  const logged = actions.record('delete', `${guest.type} ${vmid} (${guest.name})`, result);
  scheduler.runNow('pve').catch(() => {});
  if (!logged.ok) return res.status(500).json({ error: logged.output || 'delete failed' });
  res.json({ ok: true });
});

module.exports = router;
