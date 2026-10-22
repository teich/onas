// SMB shares and users (local to the onas LXC). Reads come from the store; writes go to Samba
// and then re-run the smb collector so the store catches up immediately.
const express = require('express');
const smb = require('../smb');
const actions = require('../actions');
const scheduler = require('../scheduler');
const { buildState } = require('../state');

const router = express.Router();

router.get('/smb', (req, res) => {
  const { shares, collectors } = buildState();
  res.json({ shares, timestamp: collectors.smb?.lastOk ?? null });
});

router.put('/smb', async (req, res) => {
  const { shares } = req.body || {};
  if (!Array.isArray(shares)) return res.status(400).json({ error: 'shares array required' });
  const invalid = smb.validateShares(shares);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    await smb.writeShares(shares);
    actions.record('smb-shares', shares.map(s => s.name).join(', ') || '(none)', { ok: true, exitCode: 0, output: '' });
  } catch (err) {
    actions.record('smb-shares', 'smb.conf', { ok: false, exitCode: 1, output: err.message });
    return res.status(500).json({ error: err.message });
  }
  await scheduler.runNow('smb');
  res.json({ shares: buildState().shares });
});

router.get('/users', (req, res) => {
  res.json({ users: buildState().smbUsers });
});

async function userChange(res, action, username, result) {
  // Never log passwords; these commands only ever see them on stdin.
  const logged = actions.record(action, username, result);
  await scheduler.runNow('smb');
  if (!logged.ok) return res.status(500).json({ error: logged.output || `${action} failed` });
  res.json({ ok: true, username });
}

router.post('/users', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (!smb.USERNAME_RE.test(username)) return res.status(400).json({ error: 'Invalid username' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  await userChange(res, 'smb-user-add', username, await smb.addUser(username, password));
});

router.delete('/users/:name', async (req, res) => {
  const { name } = req.params;
  if (!smb.USERNAME_RE.test(name)) return res.status(400).json({ error: 'Invalid username' });
  await userChange(res, 'smb-user-delete', name, await smb.removeUser(name));
});

router.put('/users/:name/password', async (req, res) => {
  const { name } = req.params;
  const { password } = req.body || {};
  if (!smb.USERNAME_RE.test(name)) return res.status(400).json({ error: 'Invalid username' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  await userChange(res, 'smb-user-password', name, await smb.setPassword(name, password));
});

module.exports = router;
