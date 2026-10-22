const { execFile } = require('child_process');

const HOST_SSH = process.env.PVE_DASH_SSH || 'root@192.168.2.2';
// One multiplexed connection: the first command opens it, later ones reuse it for 10 minutes.
const CONTROL_DIR = process.env.RUNTIME_DIRECTORY || '/tmp';
const SSH_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${CONTROL_DIR}/onas-ssh-%C`,
  '-o', 'ControlPersist=600',
  '-o', 'ConnectTimeout=5',
];

// Run a command on WTR. Resolves with { exitCode, stdout, stderr }; never rejects.
function sshCapture(command, { timeout = 60_000 } = {}) {
  return new Promise(resolve => {
    execFile('ssh', [...SSH_OPTS, HOST_SSH, command], { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const exitCode = err ? (Number.isInteger(err.code) ? err.code : 255) : 0;
      resolve({ exitCode, stdout: stdout || '', stderr: stderr || (err && !Number.isInteger(err.code) ? err.message : '') });
    });
  });
}

// Run a command on WTR and return stdout, rejecting on a non-zero exit.
async function sshExec(command, opts) {
  const result = await sshCapture(command, opts);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `ssh exit ${result.exitCode}`);
  return result.stdout;
}

module.exports = { sshExec, sshCapture, HOST_SSH };
